# BankPilot product design system

BankPilot borrows product-design principles from Wise—clear hierarchy, direct actions,
transparent transaction details, high contrast, and accessible zoom—without copying
Wise's proprietary font, logo, or exact brand palette.

## Typography

- Product font: Inter Variable (SIL Open Font License), with PingFang SC, Noto Sans CJK SC,
  and Microsoft YaHei as Chinese fallbacks.
- Body: 16 px; supporting copy: 14–15 px; captions and technical metadata: 12–13 px.
- Navigation: 12 px; controls: 14–16 px; display values: 38–54 px.
- Monospace is reserved for operation IDs, tokens, statuses, and audit records.
- Display text uses a tight line height and letter spacing; body text stays open and readable.

## Visual language

- Ink `#17211b` anchors financial information and primary actions.
- BankPilot lime `#dffd93` highlights AI entry points without imitating Wise's exact green.
- Paper `#f5f7f2` separates the app surface from the device frame.
- Borders and shadows remain quiet; size, spacing, and weight create hierarchy.

## Product writing

- Banking and Agent are separate user flows. Banking buttons open their own screens
  and call authenticated banking APIs directly; they must never send a hidden prompt
  or switch to chat. The dedicated AI Assistant tab and the clearly labelled home
  AI card open chat without sending a message; the user chooses what to ask.
- Statements aggregate the complete calendar month in Asia/Shanghai, independent
  of the recent-transactions list. Unavailable data must not appear as zero activity.
- Stopping a bank debit is not cancelling the merchant's subscription; label both
  the confirmation and resulting state accordingly.

- Lead with the action or outcome.
- Remove implementation detail unless it changes the user's decision.
- Show recipient, amount, fee/risk, and authorization state before execution.
- Keep sandbox and security disclosures short, visible, and precise.

## Accessibility

- Browser zoom is not disabled.
- Focus states are visible for keyboard users.
- Touch targets are generally 44 px or larger.
- Reduced-motion preferences disable non-essential motion.

## References

- [Wise Design — Get started](https://wise.design/design-at-wise/get-started)
- [Wise brand evolution](https://wise.com/gb/blog/a-brand-for-everywhere-wise-unveils-bold-new-look)
- [Wise transfer flow](https://wise.com/help/articles/2977959/how-do-i-send-money-with-wise)
- [Accessibility at Wise](https://wise.com/help/articles/473W1lKUiKkVFMNeBQgrAG/accessibility-at-wise)
