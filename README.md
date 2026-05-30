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

### Planner
- ✅ Project board with Kanban-style version columns
- ✅ Create and manage projects with custom colors
- ✅ Add versions with due dates or mark as pending
- ✅ Add tasks to versions with priority levels (High / Medium / Low)
- ✅ Mark tasks as done with checkboxes
- ✅ Versions auto-lock when past due date
- ✅ Export any project as .txt or styled .pdf report
- ✅ Projects visible on Dashboard for quick access
- ✅ Click any Dashboard project to open its board directly

### System
- ✅ Run at Windows startup (Settings toggle)
- ✅ Minimize to system tray
- ✅ All data stored locally (AppData/Roaming/worktracker)
- ✅ Firebase config section (add your own config for cloud sync)

### Calendar
- ✅ Calendar view with work session history
- ✅ Sri Lanka public holidays shown on calendar (live from official gazette data)
- ✅ Weekend days highlighted separately on calendar
- ✅ Hover tooltips for holiday names on calendar
- ✅ Click any calendar day to jump to its report

## Data Location
All data is stored at: `%AppData%\worktracker\`

## Export Folders
Exports are saved to subfolders inside `%AppData%\worktracker\exports\`:
- `Reports\` — Daily work time reports (.txt and .pdf)
- `ProjectPlans\` — Planner project exports (.txt and .pdf)

Use the **Open Exports Folder** button in the Report or Planner page to open the folder directly.

## Holiday Data
Sri Lanka public holidays are fetched automatically from:
https://github.com/Dilshan-H/srilanka-holidays

- No API key required
- Data sourced from official Sri Lankan government gazette
- Updated every year by the open-source maintainer
- Cached locally after first load (one fetch per year)

## Optional: Firebase
In Settings, enter your Firebase API Key, Project ID, and App ID to enable cloud sync.