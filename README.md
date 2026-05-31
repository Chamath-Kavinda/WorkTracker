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
3. Find your installer at: `dist/WorkTracker Setup 1.0.0.exe`

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
- ✅ Past-day tasks are automatically locked — cannot be started, paused, or stopped
- ✅ Tasks left running overnight are auto-completed at midnight with accurate session time
- ✅ Delete tasks with confirmation popup (today's tasks only)

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
- ✅ Mark individual notifications as read or mark all at once
- ✅ Bell badge and animation clear automatically once all are read

### Cloud Sync & Accounts
- ✅ Google Sign-In via system browser (no embedded browser)
- ✅ Data saved locally when not signed in
- ✅ On sign-in: local data is merged with cloud data — nothing is lost
- ✅ After sign-in: cloud is the single source of truth; local store is cleared
- ✅ Real-time sync across multiple devices via Firestore listener
- ✅ On sign-out: local data is cleared for security; sign back in to access data
- ✅ Switching accounts loads that account's own separate data

### System
- ✅ Run at Windows startup (Settings toggle)
- ✅ Minimize to system tray
- ✅ All data stored locally (AppData/Roaming/worktracker) when offline
- ✅ Country / Region setting drives timezone for all date calculations (no hardcoding)
- ✅ Supported timezones: Sri Lanka, United States, United Kingdom, India, Australia, Singapore, Germany, France, Japan, Canada

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

## Data Location
All data is stored at: `%AppData%\worktracker\`  
When signed in to a Google account, all data is synced to Firebase Firestore and the local store is kept empty.

## Export Folders
Exports are saved to subfolders inside `%AppData%\worktracker\exports\`:
- `Reports\` — Daily work time reports (.txt and .pdf)
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

## Optional: Firebase
Sign in with your Google account in the title bar or Settings page to enable cloud sync.  
To use your own Firebase project, enter your API Key, Project ID, and App ID in the Settings page.