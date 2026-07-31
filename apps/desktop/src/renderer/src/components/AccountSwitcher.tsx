import { Check, UserPlus, X } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  UserAvatar,
  cn,
} from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useAccountsStore } from "../stores/accounts-store";
import { beginAddAccount, removeAccount, switchAccount } from "../lib/account-manager";

/**
 * The multi-account switcher section for the profile-menu dropdown (ADR 0013):
 * every stored account (avatar + name, the active one checkmarked), a per-row
 * "remove" affordance (revealed on hover/focus), and an "Add account" entry that
 * opens the login overlay WITHOUT dropping the current session. Rendered inside
 * the `UserFooter` dropdown content, above Settings / Log out.
 *
 * Selecting a non-active account runs the ordered `runAccountSwitch`; removing a
 * non-active account drops it locally; removing the active one is a sign-out of
 * that account (handled by the manager).
 */
export function AccountSwitcher(): JSX.Element {
  const { t } = useAppTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);

  return (
    <>
      {accounts.map((account) => {
        const isActive = account.accountId === activeAccountId;
        return (
          <DropdownMenuItem
            key={account.accountId}
            className="group gap-2 py-1.5"
            // Selecting the active account is a no-op; switchAccount guards it too.
            onSelect={() => {
              if (!isActive) void switchAccount(account.accountId);
            }}
          >
            <UserAvatar
              name={account.displayName}
              colorSeed={account.accountId}
              src={account.avatarUrl}
              size="xs"
            />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13px] font-semibold text-fg group-data-[highlighted]:text-white">
                {account.displayName}
              </span>
              <span className="block truncate text-2xs text-fg-faint group-data-[highlighted]:text-white/70">
                @{account.username}
              </span>
            </span>
            {isActive ? (
              <Check className="size-4 shrink-0 text-accent group-data-[highlighted]:text-white" />
            ) : (
              <button
                type="button"
                aria-label={t("desktop:accounts.remove")}
                title={t("desktop:accounts.remove")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  // Keep the menu open and DON'T trigger the row's switch.
                  e.stopPropagation();
                  e.preventDefault();
                  void removeAccount(account.accountId);
                }}
                className={cn(
                  "shrink-0 rounded p-0.5 text-fg-faint opacity-0 transition-opacity",
                  "hover:text-danger group-data-[highlighted]:opacity-100",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/70",
                )}
              >
                <X className="size-3.5" />
              </button>
            )}
          </DropdownMenuItem>
        );
      })}

      <DropdownMenuItem onSelect={beginAddAccount}>
        <UserPlus className="size-4" />
        {t("desktop:accounts.add")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}
