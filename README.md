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
- Uninstaller included

## Features
- ✅ Track multiple tasks with precise timers
- ✅ Only one timer runs at a time (switching auto-pauses others)  
- ✅ Pause/resume anytime (lunch break, meetings)
- ✅ Daily reports with open time, close time, duration per task
- ✅ Export reports as .txt files & pdf files
- ✅ Run at Windows startup (Settings toggle)
- ✅ Minimize to system tray
- ✅ All data stored locally (AppData/Roaming/worktracker)
- ✅ Firebase config section (add your own config for cloud sync)
- ✅ Calendar view with work session history
- ✅ Sri Lanka public holidays shown on calendar (live from official gazette data)
- ✅ Weekend days highlighted separately on calendar
- ✅ Hover tooltips for holiday names on calendar
- ✅ Click any calendar day to jump to its report

## Data Location
All data is stored at: `%AppData%\worktracker\`

## Holiday Data
Sri Lanka public holidays are fetched automatically from:
https://github.com/Dilshan-H/srilanka-holidays

- No API key required
- Data sourced from official Sri Lankan government gazette
- Updated every year by the open-source maintainer
- Cached locally after first load (one fetch per year)

## Optional: Firebase
In Settings, enter your Firebase API Key, Project ID, and App ID to enable cloud sync.