# ReactionView

`ReactionView` is a Vencord userplugin that scans the current channel or thread and ranks messages by total reactions for:

- last day
- last week
- last month
- custom number of days

## Install

1. Copy `src/userplugins/reactionView` into your Vencord checkout at `src/userplugins/reactionView`.
2. Rebuild or reload Vencord.
3. Right-click a channel or thread and use `Top Reacted Messages`.

## Notes

- This scans one channel/thread at a time.
- It fetches history directly from Discord in 100-message pages.
- Scans are capped by the plugin settings to avoid excessive API usage.
