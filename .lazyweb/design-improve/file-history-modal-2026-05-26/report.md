# Design Improvement: File History Modal

## TL;DR
The biggest opportunity is switching from a **vertical stack** (list on top, diff below) to a **horizontal split** (list left, diff right). This is the dominant pattern in every serious diff viewer — VS Code, GitHub, GitLens, SourceTree — because it lets users keep the commit list visible while reading a long diff.

---

## Current State

The modal uses a top-bottom layout: commit list fills the top portion, and a diff pane slides in below when a commit is selected. The commit list is a 4-column grid (hash · message · author · time), all given equal visual weight.

**Key observations from the current design:**
- ✅ Clean info bar showing commit hash + author or range summary
- ✅ Shift-click range selection for multi-commit diff
- ✅ Syntax-highlighted diff with green/red line coloring
- ✅ Good modal size (95vw × 90vh)
- ❌ Vertical stacking collapses the list as the diff grows
- ❌ Hash links (bright teal) dominate visually, but aren't the primary reading target
- ❌ No line numbers in diff
- ❌ No keyboard navigation (↑↓ to move through commits)
- ❌ No visible empty state when nothing is selected

---

## Improvement Ideas

### 1. Horizontal Split: List Left · Diff Right ⭐ (highest impact)

Change the layout to left/right instead of top/bottom.

**Why this works:** When reading a diff, you inevitably need to scroll. In the current top-bottom layout, the commit list scrolls off screen immediately. In a left/right split, the list stays anchored while the diff panel scrolls independently — which is why every professional git tool uses this layout.

**Sketch:**
```
┌────────────────────────────────────────────────────────────┐
│  ⏱  文件历史  ·  A0-Inbox/中年男人的宿命.md               │
├──────────────────┬─────────────────────────────────────────┤
│ 12d08a4  2h ago  │  12d08a4 · sync: 2026-05-26T03:26...   │
│ e6dbb01 16h ago  │  Jakob He · May 26                      │
│▶d394360 17h ago  │─────────────────────────────────────────│
│ 94bf4d8 17h ago  │ @@ -7,3 +7,6 @@                        │
│ 7606696 17h ago  │   嗯嗯嗯                               │
│ 9c21a76 17h ago  │   哦哦哦                               │
│ ff83965 17h ago  │   哈哈哈                               │
│ 7855e5e 17h ago  │ +                                       │
│ 37da56f 17h ago  │ +明天会下雨。                          │
│                  │ +明天我吃饭！                          │
│                  │                                         │
├──────────────────┴─────────────────────────────────────────┤
│                                              [关闭]         │
└────────────────────────────────────────────────────────────┘
```

**Implementation:** Replace the flex-column layout with `display: grid; grid-template-columns: 280px 1fr`. Give the list panel `overflow-y: auto` and the diff panel its own scroll context.

---

### 2. Add Line Numbers to the Diff

Every serious diff viewer shows line numbers. They give spatial context ("this change is on line 47") and are essential for navigating non-trivial files.

**Sketch (diff pane rows):**
```
     │      │ @@ -7,3 +7,6 @@
   7 │    7  │   嗯嗯嗯
   8 │    8  │   哦哦哦
   9 │    9  │   哈哈哈
     │   10  │ +
     │   11  │ +明天会下雨。
     │   12  │ +明天我吃饭！
```

**Implementation:** Parse the `@@` hunk header to extract start line numbers, then increment counters as you render each line. Use `display: grid; grid-template-columns: 36px 36px 1fr` for the pre/line elements.

---

### 3. Reduce Visual Noise in the Commit List

Currently, 4 columns (hash · message · author · time) are arranged as a uniform grid — everything competes for attention. The mental model should be: **message is primary, everything else is secondary**.

**Current:**
```
12d08a4  sync: 2026-05-26T03:26:01.016Z    Jakob He  2h ago
```

**Proposed (two-line item, no grid):**
```
● sync: 2026-05-26T03:26…           2h ago
  12d08a4 · Jakob He
```

Or a single-line item with strong visual hierarchy:
```
sync: 2026-05-26T03:26…   ········  12d08a4  2h ago
(bold, fills space)                  (muted)  (muted)
```

The key changes: message gets `flex: 1` and is visually dominant; hash and time are `color: var(--text-muted)` and smaller.

---

### 4. Show a Stat Bar in the Diff Header (+N −N)

Between the commit info bar and the diff content, add a one-line stat bar showing additions and deletions. This is present in GitHub, GitLens, and Tower — it gives users a quick "how big is this change?" before reading the diff.

**Sketch:**
```
┌────────────────────────────────────────────────────┐
│ 12d08a4  sync: 2026-05-26…  Jakob He · May 26 [⎘]  │
│ ▓▓▓▓▓░░░░░░░░░░░░░░░░░  +3 −0  (3 lines changed)   │
├────────────────────────────────────────────────────┤
│ @@ -7,3 +7,6 @@                                    │
│   嗯嗯嗯                                           │
```

The green/red bar is a proportion visualization (GitHub-style). At minimum, just show `+3 −0` as text before the diff block.

---

### 5. Keyboard Navigation (↑↓ through commits)

Add `keydown` listener on the modal for `ArrowUp` / `ArrowDown` to move the selection through the commit list. This is table-stakes for developer tools — users expect to press ↓ to step through commits without reaching for the mouse.

**Implementation:**
```typescript
this.scope.register([], "ArrowDown", () => {
  const next = (this.anchorIdx ?? -1) + 1;
  if (next < this.commits.length) { this.anchorIdx = next; this.renderList(); void this.updateDiff(); }
  return false;
});
this.scope.register([], "ArrowUp", () => {
  const prev = (this.anchorIdx ?? this.commits.length) - 1;
  if (prev >= 0) { this.anchorIdx = prev; this.renderList(); void this.updateDiff(); }
  return false;
});
```

Use Obsidian's `this.scope` (available in `Modal`) so it doesn't conflict with global shortcuts.

---

## What's Working

1. **Shift-click range selection** — elegant and powerful, keep it exactly as-is
2. **Info bar for ranges** ("7855e5e → 9c21a76 · 3 commits combined") — clear and useful
3. **Diff syntax coloring** — the green/red/hunk/meta coloring is correct and readable
4. **Modal size** — 95vw × 90vh is appropriate for a diff viewer
5. **Copy hash button** — good utility, correctly positioned in the info bar

---

## Reference: Deepnote Version History (Lazyweb)

Deepnote's version history screen (https://deepnote.com/docs/history) uses a horizontal split: left sidebar lists chronological versions with timestamps and autosave labels; right pane shows the selected version's content. This directly validates the horizontal split pattern for a "history + preview" UI.

The pattern works because the timeline is a navigation control, not content — it should stay anchored while content scrolls.

---

## Priority Order

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1 | Horizontal split layout | Medium | Very High |
| 2 | Keyboard navigation (↑↓) | Low | High |
| 3 | +N −N stat bar | Low | Medium |
| 4 | Visual hierarchy in list rows | Low | Medium |
| 5 | Line numbers in diff | Medium | Medium |
