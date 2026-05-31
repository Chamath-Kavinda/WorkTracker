# WorkTracker — Build Instructions

## Requirements
- Node.js v18+ (https://nodejs.org)
- Windows 10/11 (for building the .exe)

## Build Steps

1. Open this folder in Command Prompt / PowerShell
2. Double-click BUILD.bat  
   OR run manually:
   ```
   npm install
   npm run build
   ```
3. Find your installer at: `dist/WorkTracker Setup 6.1.0.exe`

## What you get
- `.exe` NSIS installer for Windows 10/11
- Installs to Program Files with Start Menu shortcut
- Desktop shortcut created automatically

## Features

### Time Tracking
- ✅ Track multiple tasks with precise timers
- ✅ Only one timer runs at a time (switching auto-pauses others)
- ✅ Pause/resume anytime (lunch break, meetings)
- ✅ Daily reports with open time, close time, duration per task
- ✅ Export reports as .txt and .pdf files
- ✅ Tasks grouped by date on the Tasks page (newest first)
- ✅ Filter tasks by status (All / Active / Paused / Completed)
- ✅ Filter tasks by category (Work / Meeting / Design / Development / Research / Admin / Other)
- ✅ Search tasks by name on the Tasks page
- ✅ Past-day tasks are automatically locked — cannot be started, paused, or stopped
- ✅ Tasks left running overnight are auto-completed at midnight with accurate session time
- ✅ Delete tasks with confirmation popup (today's tasks only)
- ✅ Edit task name, category, and notes inline

### Idle Detection
- ✅ Configurable idle threshold — auto-pauses the active timer after inactivity
- ✅ Warning countdown shown 60 seconds before the threshold is reached
- ✅ When idle triggers: timer is paused and the active task card turns orange — it does **not** disappear
- ✅ Idle card displays "You are in idle mode — move your mouse or press any key to resume"
- ✅ Moving the mouse or pressing a key automatically resumes the timer
- ✅ Idle detection only activates when a timer is actively running

### Planner
- ✅ Project board with Kanban-style version columns
- ✅ Create and manage projects with custom colors
- ✅ Add versions with due dates or mark as pending
- ✅ Add tasks to versions with priority levels (High / Medium / Low)
- ✅ Mark tasks as done with checkboxes
- ✅ Versions lock the day **after** their due date passes (due date itself is always editable)
- ✅ Due date badges: 🔥 Due Today / ⚡ 1d left / ⚠ Xd left / 🚀 Released / 💥 Failed to Release
- ✅ Export any project as .txt or styled .pdf report
- ✅ Projects visible on Dashboard for quick access
- ✅ Click any Dashboard project to open its board directly
- ✅ **Drag-to-reorder task cards** within a version column
- ✅ **Drag tasks across versions** — drop a task card onto any unlocked version column to move it
- ✅ Locked versions cannot receive dropped tasks
- ✅ **Drag-to-reorder version columns** — grab the grip handle (⠿) in the version header and drag left or right to reorder
- ✅ Version column order is persisted and reflected in PDF/txt exports

### Report
- ✅ Daily, Weekly, and Monthly report views
- ✅ Day-by-day bar charts for weekly and monthly views
- ✅ Task breakdown with share percentage per period
- ✅ Export reports as .txt and .pdf for all three views
- ✅ Navigate between weeks and months with prev/next controls

### Notifications
- ✅ Bell icon in the title bar with animated shake and red **!** badge when reminders exist
- ✅ Bell animates every 5 seconds until all notifications are read
- ✅ Reminder notifications triggered by Planner version due dates:
  - 3 days before due — if not all tasks are done
  - 2 days before due — if not all tasks are done
  - 1 day before due — if not all tasks are done
  - On the due date — always, regardless of task completion
- ✅ Unread notifications shown in **bold**; read notifications are dimmed
- ✅ First 3 notifications shown inline; remaining hidden behind "Show more"
- ✅ Full notifications modal with tab filters (All / Unread / Read) and project filter
- ✅ Mark individual notifications as read or mark all at once
- ✅ Bell badge and animation clear automatically once all are read
- ✅ Read notification state persisted across restarts

### Cloud Sync & Accounts
- ✅ Google Sign-In via system browser (no embedded browser)
- ✅ Data saved locally when not signed in
- ✅ On sign-in: local data is merged with cloud data — nothing is lost
- ✅ After sign-in: cloud is the single source of truth; local store is cleared
- ✅ Real-time sync across multiple devices via Firestore listener
- ✅ On sign-out: local data is cleared for security; sign back in to access data
- ✅ Switching accounts loads that account's own separate data

### System Tray & Taskbar
- ✅ Minimize to system tray
- ✅ Double-click tray icon to restore window
- ✅ Right-click tray for Open / Quit menu
- ✅ **Live task overlay widget** — floating draggable panel showing active task name and elapsed time (like DU Meter)
- ✅ Overlay appears automatically when a timer starts and hides when paused or stopped
- ✅ Overlay toggle in Settings (default: off)
- ✅ Taskbar title updates live with active task name and time while tracking

### System
- ✅ Run at Windows startup (Settings toggle)
- ✅ All data stored locally (AppData/Roaming/worktracker) when offline
- ✅ Country / Region setting drives timezone for all date calculations (no hardcoding)
- ✅ Supported timezones: Sri Lanka, United States, United Kingdom, India, Australia, Singapore, Germany, France, Japan, Canada
- ✅ App version, name, and author shown in Settings pulled from package.json automatically

### Calendar
- ✅ Calendar view with work session history
- ✅ Public holidays shown based on selected Country / Region
- ✅ Sri Lanka holidays sourced live from official gazette data (no API key required)
- ✅ Weekend days highlighted separately
- ✅ Hover tooltips for holiday names
- ✅ Click any calendar day to jump to its report
- ✅ Today's date always reflects the user's local timezone

### Dashboard
- ✅ Today's Work, Active Tasks, Today's Sessions, Day Streak stats
- ✅ Day Streak counts consecutive calendar days with at least one work session
- ✅ Today's tasks shown; past-day tasks shown with 🔒 Locked badge (no delete on dashboard)
- ✅ Projects section with quick-access cards

### PDF Export (Project Plans)
- ✅ Versions exported in the same order as the board columns
- ✅ Tasks exported in the same order as the column cards
- ✅ Version status accurately shown: **RELEASED** / **FAILED TO RELEASE** / **FINISHED** / Due date
- ✅ Released versions shown with green header bar
- ✅ Failed-to-release versions shown with red header bar
- ✅ Locked versions marked with **[LOCKED]** suffix in the version name

## Data Location
All data is stored at: `%AppData%\worktracker\`  
When signed in to a Google account, all data is synced to Firebase Firestore and the local store is kept empty.

## Export Folders
Exports are saved to subfolders inside `%AppData%\worktracker\exports\`:
- `Reports\` — Daily, weekly, and monthly work time reports (.txt and .pdf)
- `ProjectPlans\` — Planner project exports (.txt and .pdf)

Use the **Open Exports Folder** button in the Report or Planner page to open the folder directly.

## Holiday Data
Public holidays are fetched based on the Country / Region selected in Settings.  
Sri Lanka holidays are fetched automatically from:  
https://github.com/Dilshan-H/srilanka-holidays

- No API key required
- Data sourced from official Sri Lankan government gazette
- Updated every year by the open-source maintainer
- Cached locally after first load (one fetch per year)