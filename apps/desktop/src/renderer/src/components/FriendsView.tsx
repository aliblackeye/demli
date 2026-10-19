import { useMemo, useState, type FormEvent } from "react";
import { Check, Loader2, MessageSquare, UserPlus, Users, X } from "lucide-react";
import {
  Button,
  Input,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
} from "@demli/ui";
import { EmptyState, RetryNotice, SectionHeading } from "@demli/app-ui";
import type { FieldError, ValidationParams } from "@demli/client-core";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "@demli/config";
import type { PresenceStatus, User } from "@demli/types";
import { addFriendError, validateAddFriendInput } from "../lib/add-friend";
import { localizeBlockedError, localizeError } from "../lib/errors";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import {
  useAcceptFriendRequest,
  useFriendRequests,
  useFriends,
  useOpenDm,
  useRemoveFriendRequest,
  useSendFriendRequestByUsername,
} from "../queries/social-queries";
import { useChatStore } from "../stores/chat-store";
import { MemberContextMenu } from "./MemberContextMenu";
import { ProfileCard } from "./ProfileCard";
import { UpdateBadge } from "./UpdateBadge";

type FriendsTab = "online" | "all" | "pending" | "add";

const PRESENCE_RANK: Record<PresenceStatus, number> = {
  online: 0,
  idle: 1,
  dnd: 2,
  offline: 3,
  invisible: 3,
};

/** A friend / request avatar+name that opens the profile popover on click. */
function PersonButton({ user }: { user: User }): JSX.Element {
  const presence = useChatStore((s) => s.presence[user.id] ?? "offline");
  const platform = useChatStore((s) => s.presencePlatforms[user.id]);
  return (
    // The SAME user menu as the roster / message rows, on right-click or
    // long-press. `display:contents` so the trigger element the menu needs adds
    // no box to the row's layout.
    <MemberContextMenu
      target={{ userId: user.id, displayName: user.displayName, username: user.username }}
      groupId={null}
    >
      <span className="contents">
        <ProfileCard userId={user.id}>
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-3 rounded-md text-left",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            )}
          >
            <UserAvatar
              name={user.displayName}
              colorSeed={user.id}
              src={user.avatarUrl}
              size="sm"
              presence={presence}
              presencePlatform={platform}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{user.displayName}</span>
              <span className="block truncate text-xs text-fg-faint">@{user.username}</span>
            </span>
          </button>
        </ProfileCard>
      </span>
    </MemberContextMenu>
  );
}

/**
 * Loading placeholder shared by the friends list and the pending list — a few
 * person-row skeletons (avatar + name + @handle) matching {@link FriendRow}'s
 * height, so people rows resolve in place instead of flashing a spinner (founder
 * rule: skeletons, not spinners, for content).
 */
function PeopleListSkeleton(): JSX.Element {
  const { t } = useAppTranslation();
  const nameWidths = ["w-24", "w-32", "w-20", "w-28", "w-36"];
  return (
    <div role="status" aria-label={t("desktop:social.loading")} className="px-4">
      <ul>
        {nameWidths.map((width, index) => (
          <li
            key={index}
            className="flex h-14 items-center gap-3 border-t border-stroke/60 px-2 first:border-t-0"
          >
            <Skeleton shape="circle" width={32} />
            <div className="min-w-0">
              <Skeleton shape="line" height={14} className={width} />
              <Skeleton shape="line" height={12} className="mt-2 w-16" />
            </div>
          </li>
        ))}
      </ul>
      <span className="sr-only">{t("desktop:social.loading")}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Friends list (Online / All)
// ---------------------------------------------------------------------------

function FriendRow({ user }: { user: User }): JSX.Element {
  const { t } = useAppTranslation();
  const openDm = useOpenDm();
  return (
    <li className="group flex min-h-14 flex-wrap items-center gap-2 border-t border-stroke/60 px-2 py-1 first:border-t-0">
      <PersonButton user={user} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label={t("desktop:social.message")}
            disabled={openDm.isPending}
            onClick={() => openDm.mutate(user.id)}
            className="opacity-0 transition-opacity motion-instant group-hover:opacity-100 focus-visible:opacity-100"
          >
            {openDm.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessageSquare className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{t("desktop:social.message")}</TooltipContent>
      </Tooltip>
      {/* Opening a DM can be refused — most often by a block that landed after
          this list was fetched (blocking severs the friendship, so the row is
          already stale). Say so on the row instead of failing silently (§26). */}
      {openDm.error && (
        <p role="alert" className="w-full px-1 pb-1 text-2xs text-danger">
          {localizeBlockedError(openDm.error, t, "message")}
        </p>
      )}
    </li>
  );
}

function FriendsList({ onlineOnly }: { onlineOnly: boolean }): JSX.Element {
  const { t } = useAppTranslation();
  const { data: friends, isPending, error, refetch } = useFriends();
  const presence = useChatStore((s) => s.presence);

  const rows = useMemo(() => {
    const list = (friends ?? []).map((f) => ({
      user: f.user,
      status: presence[f.user.id] ?? ("offline" as PresenceStatus),
    }));
    const filtered = onlineOnly ? list.filter((r) => r.status !== "offline") : list;
    return filtered.sort(
      (a, b) =>
        PRESENCE_RANK[a.status] - PRESENCE_RANK[b.status] ||
        a.user.displayName.localeCompare(b.user.displayName),
    );
  }, [friends, presence, onlineOnly]);

  if (isPending) {
    return <PeopleListSkeleton />;
  }
  if (error) {
    return (
      <RetryNotice
        message={localizeError(error, t)}
        retryLabel={t("buttons.retry")}
        onRetry={() => void refetch()}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Users className="size-6" />}
        title={
          onlineOnly ? t("desktop:social.noneOnlineTitle") : t("desktop:social.noFriendsTitle")
        }
        body={onlineOnly ? t("desktop:social.noneOnlineBody") : t("desktop:social.noFriendsBody")}
      />
    );
  }
  return (
    <div className="px-4">
      <SectionHeading>
        {onlineOnly
          ? t("desktop:social.onlineCount", { count: rows.length })
          : t("desktop:social.allCount", { count: rows.length })}
      </SectionHeading>
      <ul>
        {rows.map((r) => (
          <FriendRow key={r.user.id} user={r.user} />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending (incoming accept/decline + outgoing cancel)
// ---------------------------------------------------------------------------

function PendingList(): JSX.Element {
  const { t } = useAppTranslation();
  const incoming = useFriendRequests("incoming");
  const outgoing = useFriendRequests("outgoing");
  const accept = useAcceptFriendRequest();
  const remove = useRemoveFriendRequest();

  const isPending = incoming.isPending || outgoing.isPending;
  const incomingRows = incoming.data ?? [];
  const outgoingRows = outgoing.data ?? [];
  const empty = incomingRows.length === 0 && outgoingRows.length === 0;

  if (isPending) {
    return <PeopleListSkeleton />;
  }
  if (empty) {
    return (
      <EmptyState
        icon={<UserPlus className="size-6" />}
        title={t("desktop:social.noPendingTitle")}
        body={t("desktop:social.noPendingBody")}
      />
    );
  }

  return (
    <div className="px-4">
      {incomingRows.length > 0 && (
        <>
          <SectionHeading>
            {t("desktop:social.incomingCount", { count: incomingRows.length })}
          </SectionHeading>
          <ul>
            {incomingRows.map(({ user }) => {
              const acting =
                (accept.isPending && accept.variables === user.id) ||
                (remove.isPending && remove.variables === user.id);
              return (
                <li
                  key={user.id}
                  className="flex h-14 items-center gap-2 border-t border-stroke/60 px-2 first:border-t-0"
                >
                  <PersonButton user={user} />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label={t("desktop:social.accept")}
                        disabled={acting}
                        onClick={() => accept.mutate(user.id)}
                      >
                        <Check className="size-4 text-online" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t("desktop:social.accept")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label={t("desktop:social.decline")}
                        disabled={acting}
                        onClick={() => remove.mutate(user.id)}
                      >
                        <X className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t("desktop:social.decline")}</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {outgoingRows.length > 0 && (
        <>
          <SectionHeading>
            {t("desktop:social.outgoingCount", { count: outgoingRows.length })}
          </SectionHeading>
          <ul>
            {outgoingRows.map(({ user }) => {
              const acting = remove.isPending && remove.variables === user.id;
              return (
                <li
                  key={user.id}
                  className="flex h-14 items-center gap-2 border-t border-stroke/60 px-2 first:border-t-0"
                >
                  <PersonButton user={user} />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label={t("desktop:social.cancel")}
                        disabled={acting}
                        onClick={() => remove.mutate(user.id)}
                      >
                        {acting ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <X className="size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t("desktop:social.cancel")}</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add friend (by username — #111 replaces friend codes)
// ---------------------------------------------------------------------------

const USERNAME_FIELD_ID = "add-friend-username";
const USERNAME_HINT_ID = "add-friend-username-hint";
const USERNAME_ERROR_ID = "add-friend-username-error";

/**
 * Render a form-V1 {@link FieldError} with the desktop's `t`.
 *
 * `validateForm` types its key as a plain `string` because `@demli/client-core`
 * is shared with mobile and web and cannot know any one app's catalog union,
 * while `AppTFunction` is compile-time key-safe (ADR 0009 §2). Every key the
 * mapper can emit is listed in client-core's `VALIDATION_KEYS`, and the i18n
 * package's coverage test asserts each of them resolves in BOTH catalogs — so
 * this cast is guarded by a test rather than by the compiler, the same trade
 * `toTranslateFn` in lib/i18n already makes.
 */
function localizeFieldError(t: AppTFunction, error: FieldError): string {
  const translate = t as unknown as (key: string, params?: ValidationParams) => string;
  return translate(error.key, error.params);
}

function AddFriend(): JSX.Element {
  const { t } = useAppTranslation();
  const send = useSendFriendRequestByUsername();

  const [username, setUsername] = useState("");
  // A `{ key, params }` FieldError rather than a resolved string, so the message
  // re-translates on a live language switch (form V1 contract — the same shape
  // `validateForm` returns, whether the rule was broken locally or server-side).
  const [error, setError] = useState<FieldError | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (send.isPending) return;
    setSent(false);

    // THE username rule — imported, never re-typed here (lib/add-friend runs the
    // very schema the API runs on this body).
    const result = validateAddFriendInput(username);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setError(null);
    // The NORMALIZED value the schema produced (@ stripped, lowercased), not raw
    // field state.
    send.mutate(result.username, {
      onSuccess: () => {
        setUsername("");
        setSent(true);
      },
      onError: (err) => setError(addFriendError(err)),
    });
  };

  const invalid = error !== null;

  return (
    <div className="mx-auto max-w-xl px-6 py-6">
      <h2 className="text-base font-semibold text-fg">{t("desktop:social.addTitle")}</h2>
      <p className="mt-1 text-sm text-fg-muted">{t("desktop:social.addBody")}</p>

      {/* noValidate: the browser's own bubble would speak the OS language and
          duplicate a message we already render, localized, under the field. */}
      <form onSubmit={onSubmit} noValidate className="mt-4">
        <div className="flex gap-2">
          <Input
            id={USERNAME_FIELD_ID}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setError(null);
              setSent(false);
            }}
            // +1 for the optional leading "@", which the schema strips before
            // the real cap applies. The bound itself comes from @demli/config.
            maxLength={USERNAME_MAX_LENGTH + 1}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            placeholder={t("desktop:social.addUsernamePlaceholder")}
            aria-label={t("desktop:social.addTitle")}
            aria-invalid={invalid}
            // The rule is always announced with the field; the error joins it
            // only once there is one. A screen-reader user should hear what a
            // username may contain BEFORE they get it wrong, not only after.
            aria-describedby={
              invalid ? `${USERNAME_HINT_ID} ${USERNAME_ERROR_ID}` : USERNAME_HINT_ID
            }
            className="flex-1"
          />
          <Button type="submit" disabled={send.isPending || username.trim().length === 0}>
            {send.isPending && <Loader2 className="size-4 animate-spin" />}
            {t("desktop:social.addSubmit")}
          </Button>
        </div>
        <p id={USERNAME_HINT_ID} className="mt-2 text-xs text-fg-faint">
          {t("desktop:social.addUsernameHint", {
            min: USERNAME_MIN_LENGTH,
            max: USERNAME_MAX_LENGTH,
          })}
        </p>
        {error && (
          <p id={USERNAME_ERROR_ID} role="alert" className="mt-2 text-xs text-danger">
            {localizeFieldError(t, error)}
          </p>
        )}
        {sent && (
          <p
            role="status"
            className="mt-2 flex items-center gap-1 text-xs font-medium text-online"
          >
            <Check className="size-3.5" />
            {t("desktop:social.addSent")}
          </p>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors motion-instant",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        active ? "bg-white/[0.08] text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
      )}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-badge font-bold text-on-accent">
          {badge}
        </span>
      )}
    </button>
  );
}

/** Home-surface center pane: the friends table + add-friend (ADR 0010 §5). */
export function FriendsView(): JSX.Element {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<FriendsTab>("online");
  const incoming = useFriendRequests("incoming");
  const pendingCount = incoming.data?.length ?? 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-stroke px-4">
        <Users className="size-[18px] shrink-0 text-fg-muted" />
        <h1 className="shrink-0 text-sm font-semibold text-fg">{t("desktop:social.title")}</h1>
        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-stroke-strong" />
        <nav aria-label={t("desktop:social.tabsNav")} className="flex items-center gap-1">
          <TabButton
            active={tab === "online"}
            onClick={() => setTab("online")}
            label={t("desktop:social.tabOnline")}
          />
          <TabButton
            active={tab === "all"}
            onClick={() => setTab("all")}
            label={t("desktop:social.tabAll")}
          />
          <TabButton
            active={tab === "pending"}
            onClick={() => setTab("pending")}
            label={t("desktop:social.tabPending")}
            badge={pendingCount}
          />
          <TabButton
            active={tab === "add"}
            onClick={() => setTab("add")}
            label={t("desktop:social.tabAdd")}
          />
        </nav>
        {/* Desktop app-update badge — the top-right corner on every surface. */}
        <div className="ml-auto flex shrink-0 items-center">
          <UpdateBadge />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "online" && <FriendsList onlineOnly />}
        {tab === "all" && <FriendsList onlineOnly={false} />}
        {tab === "pending" && <PendingList />}
        {tab === "add" && <AddFriend />}
      </div>
    </div>
  );
}
