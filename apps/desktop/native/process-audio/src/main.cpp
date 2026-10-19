// Demli process-audio helper (Windows x64).
//
// Captures the audio rendered by one process tree through the WASAPI
// process-loopback virtual device and streams it as raw PCM on stdout.
// Adapted from Microsoft's Windows-classic-samples "ApplicationLoopback"
// (MIT License, Copyright (c) Microsoft Corporation) — see ../LICENSE and
// apps/desktop/resources/process-audio/LICENSE.
//
// Usage:
//   demli-audio-capture.exe <pid> <include|exclude>
//       include: only <pid> and its descendants (one app's sound)
//       exclude: everything EXCEPT <pid> and its descendants (system sound
//                without the caller — Demli passes its own main PID)
//       stdout:  interleaved PCM, 48000 Hz, signed 16-bit LE, 2 channels
//       stop:    close stdin (EOF) or kill the process
//       failure: one "error: ..." line on stderr, non-zero exit code
//   demli-audio-capture.exe --window-pid <hwnd>
//       prints the owning PID of a top-level window handle (decimal)
//   demli-audio-capture.exe --ancestors <pid>
//       prints the parent chain of <pid>, nearest first, one PID per line
//
// Exit codes: 0 ok · 2 usage · 3 COM init · 4 activation unsupported/failed ·
//             5 audio client init · 6 capture runtime failure · 7 lookup failed

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <tlhelp32.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <unordered_map>

// ---------------------------------------------------------------------------
// Process-loopback activation types. MinGW-w64's headers do not ship
// audioclientactivationparams.h, so these mirror the Windows SDK
// (10.0.26100.0 um/audioclientactivationparams.h) field for field.
// ---------------------------------------------------------------------------
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"

typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

static_assert(sizeof(AUDIOCLIENT_ACTIVATION_PARAMS) == 12, "activation params ABI");

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

namespace {

constexpr DWORD kSampleRate = 48000;
constexpr WORD kChannels = 2;
constexpr WORD kBitsPerSample = 16;
constexpr WORD kBlockAlign = kChannels * kBitsPerSample / 8;
// 100 ms of buffering inside the audio engine: enough slack that a briefly
// slow stdout reader never overruns the capture buffer.
constexpr REFERENCE_TIME kBufferDuration = 1000000;

enum ExitCode : int {
  kExitOk = 0,
  kExitUsage = 2,
  kExitComInit = 3,
  kExitActivation = 4,
  kExitClientInit = 5,
  kExitRuntime = 6,
  kExitLookup = 7,
};

int Fail(int code, const char* what, HRESULT hr) {
  std::fprintf(stderr, "error: %s (hr=0x%08lX)\n", what, static_cast<unsigned long>(hr));
  std::fflush(stderr);
  return code;
}

int FailMessage(int code, const char* what) {
  std::fprintf(stderr, "error: %s\n", what);
  std::fflush(stderr);
  return code;
}

bool ParseUnsigned(const wchar_t* text, unsigned long long* out) {
  if (text == nullptr || *text == L'\0') return false;
  for (const wchar_t* p = text; *p; ++p) {
    if (*p < L'0' || *p > L'9') return false;
  }
  errno = 0;
  wchar_t* end = nullptr;
  unsigned long long value = std::wcstoull(text, &end, 10);
  if (errno != 0 || end == nullptr || *end != L'\0') return false;
  *out = value;
  return true;
}

// ---------------------------------------------------------------------------
// ActivateAudioInterfaceAsync completion handler. Must be agile: the audio
// service calls ActivateCompleted on an MTA worker thread.
// ---------------------------------------------------------------------------
class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler,
                                public IAgileObject {
 public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() {
    if (client_) client_->Release();
    if (done_) CloseHandle(done_);
  }

  HANDLE done() const { return done_; }
  HRESULT result() const { return result_; }

  IAudioClient* TakeClient() {
    IAudioClient* client = client_;
    client_ = nullptr;
    return client;
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *ppv = static_cast<IAgileObject*>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG remaining = InterlockedDecrement(&refs_);
    if (remaining == 0) delete this;
    return remaining;
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activateHr = E_FAIL;
    IUnknown* unknown = nullptr;
    HRESULT hr = operation->GetActivateResult(&activateHr, &unknown);
    if (SUCCEEDED(hr)) hr = activateHr;
    if (SUCCEEDED(hr) && unknown != nullptr) {
      hr = unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client_));
    }
    if (unknown) unknown->Release();
    result_ = hr;
    SetEvent(done_);
    return S_OK;
  }

 private:
  LONG refs_ = 1;
  HANDLE done_;
  HRESULT result_ = E_PENDING;
  IAudioClient* client_ = nullptr;
};

using ActivateFn = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*,
                                     IActivateAudioInterfaceCompletionHandler*,
                                     IActivateAudioInterfaceAsyncOperation**);

// Resolved at runtime so an unsupported Windows reports a clean error line
// instead of failing to load with a missing-import dialog.
ActivateFn ResolveActivate() {
  HMODULE mmdevapi = LoadLibraryExW(L"Mmdevapi.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (mmdevapi == nullptr) return nullptr;
  return reinterpret_cast<ActivateFn>(
      reinterpret_cast<void*>(GetProcAddress(mmdevapi, "ActivateAudioInterfaceAsync")));
}

HANDLE g_stop = nullptr;

// stdin EOF (the parent closed the pipe or exited) is the stop signal.
DWORD WINAPI StdinWatcher(LPVOID) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buf[256];
  DWORD read = 0;
  while (in != nullptr && in != INVALID_HANDLE_VALUE &&
         ReadFile(in, buf, sizeof(buf), &read, nullptr) && read > 0) {
  }
  SetEvent(g_stop);
  return 0;
}

bool WriteAll(HANDLE out, const BYTE* data, DWORD size) {
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(out, data, size, &written, nullptr) || written == 0) return false;
    data += written;
    size -= written;
  }
  return true;
}

int RunCapture(DWORD pid, PROCESS_LOOPBACK_MODE mode) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return Fail(kExitComInit, "CoInitializeEx failed", hr);

  ActivateFn activate = ResolveActivate();
  if (activate == nullptr) {
    return FailMessage(kExitActivation, "ActivateAudioInterfaceAsync is not available");
  }

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

  PROPVARIANT activateParams;
  PropVariantInit(&activateParams);
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ActivationHandler* handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation* operation = nullptr;
  hr = activate(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activateParams,
                handler, &operation);
  if (FAILED(hr)) {
    handler->Release();
    return Fail(kExitActivation, "process loopback activation was refused", hr);
  }
  if (WaitForSingleObject(handler->done(), 5000) != WAIT_OBJECT_0) {
    if (operation) operation->Release();
    handler->Release();
    return FailMessage(kExitActivation, "process loopback activation timed out");
  }
  if (operation) operation->Release();
  hr = handler->result();
  IAudioClient* client = handler->TakeClient();
  handler->Release();
  if (FAILED(hr) || client == nullptr) {
    if (client) client->Release();
    return Fail(kExitActivation, "process loopback is not supported on this system", hr);
  }

  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = kBitsPerSample;
  format.nBlockAlign = kBlockAlign;
  format.nAvgBytesPerSec = kSampleRate * kBlockAlign;
  format.cbSize = 0;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                              AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          kBufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) {
    client->Release();
    return Fail(kExitClientInit, "audio client Initialize failed", hr);
  }

  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) {
    client->Release();
    return Fail(kExitClientInit, "GetService(IAudioCaptureClient) failed", hr);
  }

  HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (sampleReady == nullptr || g_stop == nullptr) {
    capture->Release();
    client->Release();
    return FailMessage(kExitClientInit, "CreateEvent failed");
  }
  hr = client->SetEventHandle(sampleReady);
  if (FAILED(hr)) {
    capture->Release();
    client->Release();
    return Fail(kExitClientInit, "SetEventHandle failed", hr);
  }

  HANDLE watcher = CreateThread(nullptr, 0, StdinWatcher, nullptr, 0, nullptr);
  if (watcher == nullptr) {
    capture->Release();
    client->Release();
    return FailMessage(kExitClientInit, "stdin watcher thread failed");
  }

  hr = client->Start();
  if (FAILED(hr)) {
    capture->Release();
    client->Release();
    return Fail(kExitClientInit, "audio client Start failed", hr);
  }
  std::fprintf(stderr, "ready pid=%lu mode=%s rate=%lu channels=%u bits=%u\n",
               static_cast<unsigned long>(pid),
               mode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE ? "include" : "exclude",
               static_cast<unsigned long>(kSampleRate), kChannels, kBitsPerSample);
  std::fflush(stderr);

  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  BYTE* silence = nullptr;
  size_t silenceBytes = 0;
  int exitCode = kExitOk;
  HANDLE waits[2] = {g_stop, sampleReady};

  for (;;) {
    DWORD signaled = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (signaled == WAIT_OBJECT_0) break;
    if (signaled != WAIT_OBJECT_0 + 1) {
      exitCode = FailMessage(kExitRuntime, "wait failed");
      break;
    }
    UINT32 packetFrames = 0;
    hr = capture->GetNextPacketSize(&packetFrames);
    bool streamOk = SUCCEEDED(hr);
    while (streamOk && packetFrames > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) {
        streamOk = false;
        break;
      }
      const DWORD bytes = frames * kBlockAlign;
      const BYTE* payload = data;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        if (silenceBytes < bytes) {
          std::free(silence);
          silence = static_cast<BYTE*>(std::calloc(bytes, 1));
          silenceBytes = silence ? bytes : 0;
        }
        payload = silence;
      }
      const bool written = payload != nullptr && WriteAll(out, payload, bytes);
      capture->ReleaseBuffer(frames);
      if (!written) {
        // The reader went away: a normal way to be stopped.
        SetEvent(g_stop);
        streamOk = false;
        hr = S_OK;
        break;
      }
      hr = capture->GetNextPacketSize(&packetFrames);
      streamOk = SUCCEEDED(hr);
    }
    if (WaitForSingleObject(g_stop, 0) == WAIT_OBJECT_0) break;
    if (!streamOk) {
      exitCode = Fail(kExitRuntime, "capture stream failed", hr);
      break;
    }
  }

  client->Stop();
  std::free(silence);
  capture->Release();
  client->Release();
  CloseHandle(sampleReady);
  CoUninitialize();
  return exitCode;
}

int RunWindowPid(const wchar_t* hwndText) {
  unsigned long long raw = 0;
  if (!ParseUnsigned(hwndText, &raw) || raw == 0) {
    return FailMessage(kExitUsage, "window handle must be a positive decimal integer");
  }
  HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(raw));
  if (!IsWindow(hwnd)) return FailMessage(kExitLookup, "not a window");
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0) return FailMessage(kExitLookup, "window has no owning process");
  std::printf("%lu\n", static_cast<unsigned long>(pid));
  return kExitOk;
}

bool CreationTime(DWORD pid, ULONGLONG* out) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return false;
  FILETIME created, exited, kernel, user;
  const bool ok = GetProcessTimes(process, &created, &exited, &kernel, &user) != 0;
  CloseHandle(process);
  if (!ok) return false;
  *out = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  return true;
}

int RunAncestors(const wchar_t* pidText) {
  unsigned long long raw = 0;
  if (!ParseUnsigned(pidText, &raw) || raw == 0 || raw > 0xFFFFFFFFull) {
    return FailMessage(kExitUsage, "pid must be a positive decimal integer");
  }
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return FailMessage(kExitLookup, "process snapshot failed");
  std::unordered_map<DWORD, DWORD> parentOf;
  PROCESSENTRY32W entry = {};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      parentOf[entry.th32ProcessID] = entry.th32ParentProcessID;
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);

  DWORD current = static_cast<DWORD>(raw);
  ULONGLONG currentCreated = 0;
  const bool haveCurrentTime = CreationTime(current, &currentCreated);
  for (int depth = 0; depth < 64; ++depth) {
    auto it = parentOf.find(current);
    if (it == parentOf.end()) break;
    const DWORD parent = it->second;
    if (parent == 0 || parent == current) break;
    // A parent PID can outlive its process and be reused by an unrelated,
    // younger process. A real parent was created before its child.
    ULONGLONG parentCreated = 0;
    if (haveCurrentTime && CreationTime(parent, &parentCreated) && parentCreated > currentCreated) {
      break;
    }
    std::printf("%lu\n", static_cast<unsigned long>(parent));
    current = parent;
    if (!CreationTime(current, &currentCreated)) break;
  }
  return kExitOk;
}

int Usage() {
  return FailMessage(kExitUsage,
                     "usage: demli-audio-capture <pid> <include|exclude> | --window-pid <hwnd> | "
                     "--ancestors <pid>");
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && std::wcscmp(argv[1], L"--window-pid") == 0) return RunWindowPid(argv[2]);
  if (argc == 3 && std::wcscmp(argv[1], L"--ancestors") == 0) return RunAncestors(argv[2]);
  if (argc != 3) return Usage();

  unsigned long long pid = 0;
  if (!ParseUnsigned(argv[1], &pid) || pid == 0 || pid > 0xFFFFFFFFull) {
    return FailMessage(kExitUsage, "pid must be a positive decimal integer");
  }
  PROCESS_LOOPBACK_MODE mode;
  if (std::wcscmp(argv[2], L"include") == 0) {
    mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  } else if (std::wcscmp(argv[2], L"exclude") == 0) {
    mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  } else {
    return Usage();
  }
  return RunCapture(static_cast<DWORD>(pid), mode);
}
