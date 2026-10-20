/**
 * In-chat invite embed card (davet kartı): paste an
 * `https://app.getdemli.com/invite/<kod>` link (or a legacy format) into chat and
 * the message grows a "join this server" card with the group's icon, name,
 * member counts and a live join/go button.
 *
 * Wiring: ChatDataProvider passes {@link MessageInviteEmbeds} as the shared
 * MessageRow's optional `renderInviteEmbeds` slot (confirmed messages only) and
 * FILTERS invite URLs out of the server-unfurl embeds, so the invite card wins
 * over a generic link preview for the same URL.
 *
 * State model lives in `lib/invite-embed.ts` (pure, unit-tested):
 *   preview → loading / dead (faded card, one line, no button) / unavailable
 *   (couldn't load + retry) / loaded → join ▸ joining ▸ joined("Katıldın"+git)
 *   or straight to "git" when `alreadyMember`.
 *
 * §27: rendered inside the virtualized list — the card reserves its height with
 * a min-h so resolve/reject never reflows scroll, and the preview is a per-code
 * TanStack cache so remounting rows never re-fires requests.
 */
import { memo, useMemo, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { Button, Skeleton, cn, seedColor } from "@demli/ui";
import type { Group, GroupId, InvitePreview, InviteTargetChannel } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import { api } from "../lib/api-client";
import { findInviteCodesInText } from "../lib/invite-link";
import {
  invitePreviewProblem,
  inviteRedeemOutcome,
  resolveInviteCardAction,
  type InviteDeadReason,
} from "../lib/invite-embed";
import { queryClient, queryKeys } from "../lib/query-client";
import { useInvitePreview, useRedeemInviteFromEmbed } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";

/** Same cap as MessageEmbeds: a message never floods the column. */
const MAX_INVITE_CARDS = 3;

/** Localize the one-line epitaph of a dead invite. */
function deadReasonText(reason: InviteDeadReason, t: AppTFunction): string {
  switch (reason) {
    case "expired":
      return t("desktop:inviteEmbed.expired");
    case "exhausted":
      return t("desktop:inviteEmbed.exhausted");
    case "invalid":
      return t("desktop:inviteEmbed.invalid");
  }
}

const createdDateFormat = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** The card's fixed shell — same skeleton for every state so height is stable. */
function CardShell({
  faded,
  children,
}: {
  faded?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        // Koyu Masa card: radius 16, no frame. Wash fill (not a surface tone) so
        // it stays a step above the row on hover too — see LinkEmbedCard.
        "mt-1.5 flex min-h-[88px] w-full max-w-[430px] flex-col justify-center rounded-xl bg-wash p-3.5",
        "transition-opacity motion-fast",
        faded && "opacity-60",
      )}
    >
      {children}
    </div>
  );
}

/** Group icon or its initial — servers are squircles, not user circles. */
function GroupIcon({
  name,
  iconUrl,
  colorSeed,
}: {
  name: string;
  iconUrl: string | null;
  colorSeed: string;
}): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (iconUrl && !broken) {
    return (
      <img
        src={iconUrl}
        alt=""
        onError={() => setBroken(true)}
        className="size-11 shrink-0 rounded-xl object-cover"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex size-11 shrink-0 items-center justify-center rounded-xl font-display text-base font-semibold text-fg-display"
      style={{ backgroundColor: seedColor(colorSeed) }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </div>
  );
}

/**
 * Navigate to the invite's group. Servers switch the rail; flat group chats
 * need their hidden stream channel id, resolved from the group-chats cache (or
 * one fetch when the list has not loaded yet — right after a fresh join).
 */
async function goToInviteTarget(
  kind: InvitePreview["kind"],
  groupId: GroupId,
  targetChannel: InviteTargetChannel | null,
): Promise<void> {
  if (kind === "server") {
    // A channel invite lands on its channel. Seeded BEFORE `openServer`, which
    // reads `lastChannelByGroup` for its provisional selection — after would
    // paint #general first and then jump. A VOICE target is SELECTED, never
    // connected: pressing "go" opens the room's chat with its join affordance,
    // and the user presses Join themselves (founder's two-press flow).
    if (targetChannel) {
      useChatStore.getState().rememberChannelForGroup(groupId, targetChannel.id);
    }
    useChatStore.getState().openServer(groupId);
    return;
  }
  const cached = queryClient.getQueryData<Group[]>(queryKeys.groupChats);
  const groups = cached ?? (await api.listGroupChats()).groups;
  const target = groups.find((g) => g.id === groupId);
  if (target) {
    useChatStore.getState().openGroupChat({ id: target.id, streamId: target.streamId });
  } else {
    // Membership exists but the list is momentarily behind — land on home
    // rather than a broken deep-jump; the chat appears in the sidebar.
    useChatStore.getState().openHome();
  }
}

const InviteEmbedCard = memo(function InviteEmbedCard({ code }: { code: string }): JSX.Element {
  const { t } = useAppTranslation();
  const preview = useInvitePreview(code);
  const redeem = useRedeemInviteFromEmbed();
  // Sticky per-card state the mutations feed: a successful redeem ("Katıldın"),
  // a CONFLICT that revealed membership, or a redeem that proved the invite dead.
  const [joined, setJoined] = useState(false);
  const [memberViaConflict, setMemberViaConflict] = useState(false);
  const [deadFromRedeem, setDeadFromRedeem] = useState<InviteDeadReason | null>(null);
  const [redeemFailed, setRedeemFailed] = useState(false);

  const isServer = preview.data ? preview.data.kind === "server" : true;
  const label = isServer
    ? t("desktop:inviteEmbed.labelServer")
    : t("desktop:inviteEmbed.labelGroup");

  /* ── Loading ── */
  if (preview.isPending) {
    return (
      // The loaded card's own shape, pulsing — so resolving swaps tones, never
      // layout (the shell's min-height already pins the row for the list, §27).
      <CardShell>
        <div role="status" aria-label={t("desktop:inviteEmbed.loading")}>
          <Skeleton shape="line" width={150} height={10} />
          <div className="mt-2.5 flex items-center">
            <Skeleton shape="rect" width={44} height={44} className="rounded-xl" />
            <div className="ml-3 min-w-0 flex-1">
              <Skeleton shape="line" width="60%" height={12} />
              <Skeleton shape="line" width="40%" height={10} className="mt-2" />
            </div>
            <Skeleton shape="rect" width={92} height={29} className="ml-3 rounded-md" />
          </div>
        </div>
      </CardShell>
    );
  }

  /* ── Preview failed: dead invite vs our transport ── */
  if (preview.isError) {
    const problem = invitePreviewProblem(preview.error);
    if (problem.kind === "dead") {
      return (
        <CardShell faded>
          <p className="text-xs font-medium text-fg-faint">{label}</p>
          <p className="mt-1.5 text-sm text-fg-muted">{deadReasonText(problem.reason, t)}</p>
        </CardShell>
      );
    }
    return (
      <CardShell>
        <p role="alert" className="text-sm text-fg-muted">{t("desktop:inviteEmbed.unavailable")}</p>
        <div className="mt-2.5">
          <Button
            variant="secondary"
            size="sm"
            loading={preview.isFetching}
            onClick={() => void preview.refetch()}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {t("buttons.retry")}
          </Button>
        </div>
      </CardShell>
    );
  }

  const data = preview.data;

  /* ── A redeem attempt proved the invite dead after a good preview ── */
  if (deadFromRedeem !== null) {
    return (
      <CardShell faded>
        <p className="text-xs font-medium text-fg-faint">{label}</p>
        <p className="mt-1.5 text-sm text-fg-muted">{deadReasonText(deadFromRedeem, t)}</p>
      </CardShell>
    );
  }

  const { action, joinedNow } = (() => {
    const resolved = resolveInviteCardAction({
      alreadyMember: data.alreadyMember || memberViaConflict,
      joined,
    });
    return resolved.action === "go" ? resolved : { action: "join" as const, joinedNow: false };
  })();

  // After a fresh join the preview's groupId can be null/stale — the redeem
  // response's group is authoritative for navigation.
  const targetGroupId = redeem.data?.group.id ?? data.groupId;

  const onJoin = (): void => {
    if (redeem.isPending) return;
    setRedeemFailed(false);
    redeem.mutate(code, {
      onSuccess: () => setJoined(true),
      onError: (error) => {
        const outcome = inviteRedeemOutcome(error);
        if (outcome.kind === "member") setMemberViaConflict(true);
        else if (outcome.kind === "dead") setDeadFromRedeem(outcome.reason);
        else setRedeemFailed(true);
      },
    });
  };

  const memberLine = [
    data.onlineCount !== null
      ? t("desktop:inviteEmbed.online", { count: data.onlineCount })
      : null,
    t("desktop:inviteEmbed.members", { count: data.memberCount }),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <CardShell>
      <p className="text-xs font-medium text-fg-faint">{label}</p>
      {/* Safari 12 (web surface): no flex gap → space-x-3. */}
      <div className="mt-2 flex items-center space-x-3">
        <GroupIcon
          name={data.groupName}
          iconUrl={data.groupIconUrl}
          colorSeed={data.groupId ?? data.groupName}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{data.groupName}</p>
          <p className="mt-0.5 flex items-center space-x-1.5 text-xs text-fg-muted">
            {data.onlineCount !== null && (
              <span aria-hidden className="inline-block size-2 shrink-0 rounded-full bg-online" />
            )}
            <span className="truncate">{memberLine}</span>
          </p>
          <p className="mt-0.5 truncate text-2xs text-fg-faint">
            {t("desktop:inviteEmbed.created", {
              date: createdDateFormat.format(new Date(data.createdAt)),
            })}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          {action === "join" ? (
            <Button variant="accent" size="sm" loading={redeem.isPending} onClick={onJoin}>
              {isServer
                ? t("desktop:inviteEmbed.joinServer")
                : t("desktop:inviteEmbed.joinGroup")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={targetGroupId === null}
              onClick={() => {
                if (targetGroupId !== null) {
                  // The preview's target is resolved per-VIEWER (null when this
                  // viewer could not see the channel), so it is exactly the
                  // right answer for a member pressing "go" — and for a fresh
                  // joiner the redeem already seeded the same destination.
                  void goToInviteTarget(data.kind, targetGroupId, data.targetChannel ?? null);
                }
              }}
            >
              {isServer ? t("desktop:inviteEmbed.goServer") : t("desktop:inviteEmbed.goGroup")}
            </Button>
          )}
          {joinedNow && (
            <span className="mt-1 flex items-center space-x-1 text-2xs font-medium text-online">
              <Check className="size-3.5 shrink-0" />
              <span>{t("desktop:inviteEmbed.joined")}</span>
            </span>
          )}
        </div>
      </div>
      {redeemFailed && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {t("desktop:inviteEmbed.joinFailed")}
        </p>
      )}
    </CardShell>
  );
});

/**
 * The invite cards under one message, detected from its raw content. Memoized
 * on the content STRING — an unchanged message skips the regex and the subtree
 * entirely (§27); a message with no invite links renders null at zero DOM cost.
 */
export const MessageInviteEmbeds = memo(function MessageInviteEmbeds({
  content,
}: {
  content: string;
}): JSX.Element | null {
  const codes = useMemo(() => findInviteCodesInText(content), [content]);
  if (codes.length === 0) return null;
  return (
    <div className="flex flex-col">
      {codes.slice(0, MAX_INVITE_CARDS).map((code) => (
        <InviteEmbedCard key={code} code={code} />
      ))}
    </div>
  );
});
