/**
 * KOYU MASA MOBILE UI KIT — dev-only review surface (M16 Wave 4 gate), the RN
 * twin of apps/web `/ui-kit.html`.
 *
 * Reach it in a dev build with `demli://ui-kit` (or `npx uri-scheme open
 * demli://ui-kit --android`). In a release build `__DEV__` is false and the
 * route renders a redirect home before any of the kit mounts, so nothing here
 * is reachable by a user.
 *
 * Every demo is LIVE and wired to state: toggles toggle, the slider moves a
 * value, toasts queue through the real `toast()`, sheets drag with the real
 * physics, the error field validates as you type. Nothing is a picture of a
 * component.
 *
 * The page chrome (section titles, notes) is Turkish developer text and stays
 * out of the i18n catalogs on purpose: it is never shown to a user (same rule
 * as the web kit). Labels INSIDE the primitives use real product keys, so the
 * copy under review is the copy that ships.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Image, ScrollView, View } from "react-native";
import { Redirect, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Bell,
  Camera,
  Copy,
  Hash,
  LogOut,
  Mic,
  MicOff,
  MoreHorizontal,
  PhoneOff,
  Plus,
  Search,
  Settings,
  Trash2,
  UserPlus,
  Users,
  WifiOff,
} from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { Row } from "@/components/Row";
import { Segmented } from "@/components/Segmented";
import { SkeletonList } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { UnreadCountBadge } from "@/components/home/UnreadCountBadge";
import { ActionDivider, ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { AvatarStack } from "@/components/ui/AvatarStack";
import { Badge, CountBadge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { Checkbox, RadioGroup } from "@/components/ui/Checkbox";
import { Chip } from "@/components/ui/Chip";
import { IconButton } from "@/components/ui/IconButton";
import { Sheet } from "@/components/ui/Sheet";
import { Slider } from "@/components/ui/Slider";
import { Switch } from "@/components/ui/Switch";
import { Text } from "@/components/ui/Text";
import { toast } from "@/components/ui/Toast";
import { colors, radius, space } from "@/theme/theme";

export default function UiKitScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Kit />;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: 2 }}>
        <Text type="heading" tone="display">
          {title}
        </Text>
        {note ? (
          <Text type="meta" tone="faint">
            {note}
          </Text>
        ) : null}
      </View>
      <View style={{ backgroundColor: colors.sidebar, borderRadius: radius.card, padding: space.lg, gap: space.md }}>
        {children}
      </View>
    </View>
  );
}

function Wrap({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>{children}</View>;
}

/**
 * A REAL image for the photo path (crossfade, cache, ring over a photo): the
 * bundled app icon, resolved to a local asset URI — no network, no stranger's
 * face in a dev screen.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PHOTO = Image.resolveAssetSource(require("../../assets/icon.png")).uri;

const PEOPLE = [
  { id: "1", name: "Ali Karagöz", avatarUrl: PHOTO },
  { id: "2", name: "Burak Demir", avatarUrl: null },
  { id: "3", name: "Mert Yıldız", avatarUrl: null },
  { id: "4", name: "Can Aydın", avatarUrl: null },
  { id: "5", name: "Ece Şahin", avatarUrl: null },
  { id: "6", name: "Zeynep İnan", avatarUrl: null },
];

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "accent", "danger", "ghost", "outline"];

function Kit() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [unread, setUnread] = useState(7);
  const [presenceTab, setPresenceTab] = useState<"servers" | "groups">("servers");
  const [muteLevel, setMuteLevel] = useState<"all" | "mentions">("all");
  const [chips, setChips] = useState(["#genel", "#oyun", "#film"]);
  const [filter, setFilter] = useState<Set<string>>(new Set(["online"]));
  const [speaking, setSpeaking] = useState(true);
  const [haptic, setHaptic] = useState(true);
  const [effects, setEffects] = useState(false);
  const [volume, setVolume] = useState(80);
  const [boxes, setBoxes] = useState({ a: true, b: false });
  const [username, setUsername] = useState("");
  const [touched, setTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [menu, setMenu] = useState(false);
  const [tall, setTall] = useState(false);
  const [locked, setLocked] = useState(false);
  const [selectedRow, setSelectedRow] = useState(0);

  const usernameError = touched && username.trim().length < 3 ? t("mobile:auth.validationUsername") : null;
  const parent = boxes.a && boxes.b ? true : boxes.a || boxes.b ? "mixed" : false;
  const longList = useMemo(() => Array.from({ length: 24 }, (_, i) => `#kanal-${i + 1}`), []);

  return (
    <>
      <Stack.Screen options={{ title: "Koyu Masa UI kit", headerShown: true }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.rail }}
        contentContainerStyle={{ padding: space.lg, gap: space.xl, paddingBottom: insets.bottom + 120 }}
        keyboardShouldPersistTaps="handled"
      >
        <Section title="Tipografi" note="Onest başlık · Inter gövde · tonlar">
          <Text type="title" tone="display">
            {t("mobile:home.serversEmptyTitle")}
          </Text>
          <Text type="heading">{t("mobile:friends.title")}</Text>
          <Text type="subheading">{t("mobile:sound.section")}</Text>
          <Text type="body">{t("mobile:home.serversEmptySubtitle")}</Text>
          <Text type="ui" tone="muted">
            {t("mobile:sound.effectsDesc")}
          </Text>
          <Text type="meta" tone="faint">
            {t("mobile:sound.note")}
          </Text>
          <Wrap>
            <Text type="label" tone="accent">
              {t("mobile:presence.online")}
            </Text>
            <Text type="label" tone="danger">
              {t("mobile:presence.dnd")}
            </Text>
            <Text type="label" tone="warning">
              {t("mobile:presence.idle")}
            </Text>
          </Wrap>
        </Section>

        <Section title="Butonlar" note="Basış = ton + 0.97 ölçek · devre dışı %40 · meşgul genişliği korur">
          {VARIANTS.map((v) => (
            <Wrap key={v}>
              <Button variant={v} size="lg" label={t("common:buttons.save")} onPress={() => toast({ title: v })} />
              <Button variant={v} label={t("common:buttons.copy")} icon={Copy} onPress={() => toast({ title: t("common:buttons.copied"), key: "copy" })} />
              <Button variant={v} size="sm" label={t("common:buttons.cancel")} onPress={() => {}} />
            </Wrap>
          ))}
          <Wrap>
            <Button variant="dangerSolid" icon={PhoneOff} label={t("mobile:voice.controlLeave")} haptic="medium" onPress={() => toast({ title: t("mobile:voice.controlLeave"), variant: "danger" })} />
            <Button
              variant="primary"
              label={t("common:buttons.signIn")}
              loading={busy}
              onPress={() => {
                setBusy(true);
                setTimeout(() => setBusy(false), 1800);
              }}
            />
            <Button variant="accent" label={t("common:buttons.create")} disabled onPress={() => {}} />
          </Wrap>
          <Button variant="accent" size="lg" block icon={UserPlus} label={t("mobile:friends.addFriend")} onPress={() => {}} />
        </Section>

        <Section title="İkon butonları" note="Uzun bas → ipucu · aç/kapa durumu duyurulur">
          <Wrap>
            <IconButton icon={muted ? MicOff : Mic} toggle active={muted} variant="secondary" size="xl" label={muted ? t("mobile:voice.controlUnmute") : t("mobile:voice.controlMute")} haptic="light" onPress={() => setMuted((m) => !m)} />
            <IconButton icon={Camera} variant="secondary" size="xl" label={t("mobile:voice.cameraPreview.confirm")} onPress={() => {}} />
            <IconButton icon={PhoneOff} variant="dangerSolid" size="xl" label={t("mobile:voice.controlLeave")} onPress={() => {}} />
          </Wrap>
          <Wrap>
            <IconButton icon={Settings} label={t("mobile:home.settings")} onPress={() => {}} />
            <IconButton icon={Search} label={t("mobile:search.title")} shape="square" onPress={() => {}} />
            <IconButton icon={Bell} label={t("common:a11y.notifications")} badge={<CountBadge count={unread} />} onPress={() => setUnread(0)} />
            <IconButton icon={Trash2} variant="danger" label={t("common:buttons.delete")} onPress={() => {}} />
            <IconButton icon={MoreHorizontal} variant="veil" size="sm" label={t("common:a11y.moreActions")} onPress={() => {}} />
            <IconButton icon={Plus} variant="accent" label={t("mobile:home.addAction")} disabled onPress={() => {}} />
          </Wrap>
        </Section>

        <Section title="Rozetler ve çipler" note="Sayaç 0'da kaybolur, 99 üstü 99+ · çipler gerçek seçim tutar">
          <Wrap>
            <Badge label={t("mobile:presence.online")} variant="success" />
            <Badge label={t("mobile:mute.muted")} variant="neutral" />
            <Badge label={t("mobile:presence.idle")} variant="warning" />
            <Badge label={t("mobile:presence.dnd")} variant="danger" />
            <Badge label={t("mobile:home.tabServers")} variant="accent" />
            <Badge label={t("mobile:voice.statusConnected")} variant="veil" />
          </Wrap>
          <Wrap>
            <CountBadge count={unread} label={`${unread}`} />
            <CountBadge count={unread * 20} tone="danger" />
            <CountBadge count={3} tone="muted" />
            <UnreadCountBadge text="12" tone="neutral" />
            <Button variant="secondary" size="sm" icon={Plus} label="+1" onPress={() => setUnread((n) => n + 1)} />
            <Button variant="ghost" size="sm" label="0" onPress={() => setUnread(0)} />
          </Wrap>
          <Segmented
            options={[
              { value: "servers", label: t("mobile:home.tabServers") },
              { value: "groups", label: t("mobile:home.tabGroups") },
            ]}
            value={presenceTab}
            onChange={setPresenceTab}
          />
          <Wrap>
            {(["online", "idle", "dnd"] as const).map((k) => (
              <Chip
                key={k}
                role="checkbox"
                label={t(`mobile:presence.${k}`)}
                selected={filter.has(k)}
                onPress={() =>
                  setFilter((s) => {
                    const n = new Set(s);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    return n;
                  })
                }
              />
            ))}
          </Wrap>
          <Wrap>
            {chips.map((c) => (
              <Chip key={c} label={c} leading={<Hash size={14} color={colors.fgMuted} />} onRemove={() => setChips((l) => l.filter((x) => x !== c))} />
            ))}
            {chips.length === 0 ? (
              <Button variant="ghost" size="sm" label={t("common:buttons.retry")} onPress={() => setChips(["#genel", "#oyun", "#film"])} />
            ) : null}
          </Wrap>
        </Section>

        <Section title="Avatarlar" note="Halka · konuşma halkası (aç/kapa) · durum · bozuk adres → baş harfler">
          <Wrap>
            <Avatar name="Ali Karagöz" uri={null} size="xs" presence="online" />
            <Avatar name="Burak Demir" uri={null} size="sm" presence="idle" />
            <Avatar name="Mert Yıldız" uri={null} size="md" presence="dnd" />
            <Avatar name="Can Aydın" uri={PHOTO} size="lg" presence="online" platform="mobile" speaking={speaking} />
            <Avatar name="Ece Şahin" uri="https://invalid.invalid/none.png" size="xl" presence="offline" ring />
          </Wrap>
          <Switch value={speaking} onValueChange={setSpeaking} label={t("mobile:voice.statusConnected")} />
          <AvatarStack people={PEOPLE} max={4} size={32} ringColor={colors.sidebar} label={PEOPLE.map((p) => p.name).join(", ")} />
        </Section>

        <Section title="Kontroller" note="Anahtar konum yayıyla · sürgü UI iş parçacığında · TalkBack ayarlanabilir">
          <Switch value={haptic} onValueChange={setHaptic} label={t("mobile:haptics.enable")} description={t("mobile:haptics.enableDesc")} />
          <Switch value={effects} onValueChange={setEffects} label={t("mobile:sound.effects")} disabled />
          <Checkbox
            checked={parent}
            label={t("mobile:sound.section")}
            onChange={(next) => setBoxes({ a: next, b: next })}
          />
          <View style={{ paddingLeft: space.xl }}>
            <Checkbox checked={boxes.a} label={t("mobile:sound.effects")} onChange={(v) => setBoxes((b) => ({ ...b, a: v }))} />
            <Checkbox checked={boxes.b} label={t("mobile:sound.messageNotif")} description={t("mobile:sound.messageNotifDesc")} onChange={(v) => setBoxes((b) => ({ ...b, b: v }))} />
          </View>
          <RadioGroup
            accessibilityLabel={t("mobile:mute.muteNotifications")}
            value={muteLevel}
            onChange={setMuteLevel}
            options={[
              { value: "all", label: t("mobile:mute.all") },
              { value: "mentions", label: t("mobile:mute.mentionsOnly") },
            ]}
          />
          <Slider
            value={volume}
            onValueChange={setVolume}
            min={0}
            max={200}
            step={5}
            showValue
            formatValue={(v) => `%${v}`}
            accessibilityLabel={t("mobile:sound.volume")}
          />
          <Slider value={40} onValueChange={() => {}} max={100} disabled accessibilityLabel={t("mobile:sound.volume")} />
        </Section>

        <Section title="Alanlar" note="Odakta ton yükselir · mercan imleç · hata = alanın zemini, çerçeve yok">
          <TextField
            label={t("mobile:auth.usernameLabel")}
            placeholder={t("mobile:auth.usernamePlaceholder")}
            hint={t("mobile:friends.addByUsernameHint")}
            value={username}
            onChangeText={setUsername}
            onBlur={() => setTouched(true)}
            error={usernameError}
            autoCapitalize="none"
          />
          <TextField
            label={t("mobile:auth.passwordLabel")}
            placeholder={t("mobile:auth.passwordPlaceholderLogin")}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          <TextField leading={<Search size={16} color={colors.fgFaint} />} placeholder={t("mobile:search.placeholder")} />
          <TextField label={t("mobile:auth.displayNameLabel")} value="Ali" editable={false} />
        </Section>

        <Section title="Satırlar" note="Basış yalnız ton — kalkma/zıplama yok">
          {[t("mobile:home.tabServers"), t("mobile:home.tabGroups"), t("mobile:home.directTitle")].map((title, i) => (
            <Row
              key={title}
              title={title}
              subtitle={i === 0 ? t("mobile:presence.online") : undefined}
              leading={<Users size={18} color={colors.fgMuted} />}
              selected={selectedRow === i}
              trailing={i === 1 ? <UnreadCountBadge text="3" /> : undefined}
              onPress={() => setSelectedRow(i)}
            />
          ))}
          <Row title={t("mobile:home.newServer")} accent leading={<Plus size={18} color={colors.accent} />} onPress={() => {}} />
          <Row title={t("mobile:mute.muted")} dimmed onPress={() => {}} />
          <Row title={t("mobile:connection.offline")} disabled onPress={() => {}} />
        </Section>

        <Section title="Durumlar" note="Yükleniyor (ışık süpürmesi, azaltılmış harekette durağan) → boş / hata">
          <Button variant="secondary" size="sm" label={loading ? t("common:buttons.close") : t("common:buttons.retry")} onPress={() => setLoading((l) => !l)} />
          {loading ? (
            <SkeletonList count={3} />
          ) : (
            <EmptyState
              icon={<Users size={22} color={colors.fgMuted} />}
              title={t("mobile:friends.noFriendsTitle")}
              subtitle={t("mobile:friends.noFriendsSubtitle")}
              action={<Button variant="accent" size="sm" label={t("mobile:friends.addFriend")} onPress={() => {}} />}
            />
          )}
          <EmptyState
            tone="error"
            compact
            icon={<WifiOff size={22} color={colors.danger} />}
            title={t("mobile:search.error")}
            subtitle={t("common:errors.network")}
            action={<Button variant="secondary" size="sm" label={t("common:buttons.retry")} onPress={() => {}} />}
          />
        </Section>

        <Section title="Bildirimler" note="Bant akış içinde · tost kuyruğu gerçek toast() · yana kaydır = kapat">
          {bannerOpen ? (
            <Banner
              variant="danger"
              title={t("mobile:connection.offline")}
              description={t("common:errors.network")}
              action={{ label: t("common:buttons.retry"), onPress: () => toast({ title: t("mobile:connection.reconnecting") }) }}
              onDismiss={() => setBannerOpen(false)}
            />
          ) : (
            <Button variant="ghost" size="sm" label={t("common:buttons.retry")} onPress={() => setBannerOpen(true)} />
          )}
          <Banner variant="warning" title={t("mobile:voice.shareScreenHint.title")} description={t("mobile:voice.shareScreenHint.message")} />
          <Banner variant="success" title={t("mobile:voice.statusConnected")} />
          <Banner variant="info" title={t("mobile:sound.note")} />
          <Wrap>
            <Button variant="secondary" size="sm" label="neutral" onPress={() => toast({ title: t("common:buttons.copied"), key: "copy" })} />
            <Button variant="secondary" size="sm" label="success" onPress={() => toast({ title: t("mobile:voice.statusConnected"), variant: "success" })} />
            <Button
              variant="secondary"
              size="sm"
              label="accent"
              onPress={() =>
                toast({
                  title: t("mobile:friends.addFriend"),
                  description: t("mobile:friends.pendingSubtitle"),
                  variant: "accent",
                  action: { label: t("mobile:friends.cancelRequest"), onPress: () => {} },
                })
              }
            />
            <Button variant="secondary" size="sm" label="danger" onPress={() => toast({ title: t("mobile:search.error"), description: t("common:errors.network"), variant: "danger", duration: Infinity })} />
          </Wrap>
        </Section>

        <Section title="Sayfalar (sheet)" note="Yaylı açılış · sürükle/fırlat = kapat · çoklu durak · klavye kaçınma">
          <Wrap>
            <Button variant="secondary" label={t("common:a11y.moreActions")} onPress={() => setMenu(true)} />
            <Button variant="secondary" label={t("mobile:search.title")} onPress={() => setTall(true)} />
            <Button variant="secondary" label={t("common:buttons.confirm")} onPress={() => setLocked(true)} />
          </Wrap>
        </Section>
      </ScrollView>

      <ActionSheet visible={menu} title="Ali Karagöz" onClose={() => setMenu(false)}>
        <ActionRow icon={<Users size={20} color={colors.fgMuted} />} label={t("mobile:userMenu.profile")} onPress={() => setMenu(false)} />
        <ActionRow icon={<Bell size={20} color={colors.fgMuted} />} label={t("mobile:userMenu.ignore")} hint={t("mobile:userMenu.ignoreHint")} onPress={() => setMenu(false)} />
        <ActionRow icon={<UserPlus size={20} color={colors.fgMuted} />} label={t("mobile:userMenu.addFriend")} trailing={<Badge label={t("mobile:presence.online")} variant="success" />} onPress={() => setMenu(false)} />
        <ActionDivider />
        <ActionRow icon={<LogOut size={20} color={colors.danger} />} label={t("mobile:userMenu.removeFriend")} labelColor={colors.danger} onPress={() => setMenu(false)} />
      </ActionSheet>

      <Sheet visible={tall} onClose={() => setTall(false)} title={t("mobile:search.title")} snapPoints={["55%", "92%"]}>
        <TextField leading={<Search size={16} color={colors.fgFaint} />} placeholder={t("mobile:search.placeholder")} />
        {longList.map((c) => (
          <Row key={c} title={c} leading={<Hash size={18} color={colors.fgMuted} />} onPress={() => setTall(false)} />
        ))}
      </Sheet>

      <Sheet
        visible={locked}
        onClose={() => setLocked(false)}
        dismissible={false}
        title={t("mobile:userMenu.voiceDisconnectTitle", { name: "Burak" })}
        description={t("mobile:userMenu.voiceDisconnectDescription")}
        footer={
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button variant="secondary" label={t("common:buttons.cancel")} style={{ flex: 1 }} onPress={() => setLocked(false)} />
            <Button variant="danger" label={t("mobile:voice.controlLeave")} style={{ flex: 1 }} onPress={() => setLocked(false)} />
          </View>
        }
      >
        <View />
      </Sheet>
    </>
  );
}
