; ============================================================
;  WorkTracker — electron-builder NSIS include file
;  Compatible with perMachine:true (multiUser.nsh template)
; ============================================================

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
${StrStr}

; ── Variables ─────────────────────────────────────────────────────────────────
Var CB_Desktop
Var CB_Startup
Var CB_StartMenu

; ── Set default install dir ────────────────────────────────────────────────────
!macro customInit
  StrCpy $INSTDIR "$PROGRAMFILES64\WorkTracker"
!macroend

; ── Force Welcome page ────────────────────────────────────────────────────────
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to WorkTracker ${VERSION} Setup"
  !define MUI_WELCOMEPAGE_TEXT "This wizard will guide you through the installation of WorkTracker.$\r$\n$\r$\nWorkTracker is a powerful work-time tracker with multiple timers, daily reports, Kanban planner, idle detection, cloud sync, and more.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ── Show details auto-expanded on the instfiles page ─────────────────────────
; MUI_PAGE_CUSTOMFUNCTION_SHOW must be defined BEFORE MUI_PAGE_INSTFILES
; assistedInstaller.nsh calls customPageAfterChangeDir just before MUI_PAGE_INSTFILES
; so we define the show-hook here — perfect timing.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW autoExpandDetails
  Page custom customOptionsPage customOptionsPageLeave
!macroend

; This function fires when the instfiles page is SHOWN (before extraction starts)
; It sends a BM_CLICK to the "Show details" button to expand the log immediately
Function autoExpandDetails
  ; Control ID 1027 = "Show details" button on MUI instfiles page
  GetDlgItem $R0 $HWNDPARENT 1027
  SendMessage $R0 ${BM_CLICK} 0 0
FunctionEnd

; ── Custom Options page ────────────────────────────────────────────────────────
Function customOptionsPage
  ; Append \WorkTracker if not already present
  ${StrStr} $R0 $INSTDIR "WorkTracker"
  ${If} $R0 == ""
    StrCpy $INSTDIR "$INSTDIR\WorkTracker"
  ${EndIf}

  ; Write the updated path back into the directory page textfield
  GetDlgItem $R2 $HWNDPARENT 1019
  ${If} $R2 <> 0
    SendMessage $R2 ${WM_SETTEXT} 0 "STR:$INSTDIR"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Choose additional installation options:"

  ${NSD_CreateCheckbox} 0 28u 100% 12u "Create a Desktop shortcut"
  Pop $CB_Desktop
  ${NSD_Check} $CB_Desktop

  ${NSD_CreateCheckbox} 0 46u 100% 12u "Launch WorkTracker automatically when Windows starts"
  Pop $CB_Startup
  ${NSD_Check} $CB_Startup

  ${NSD_CreateCheckbox} 0 64u 100% 12u "Add WorkTracker to the Start Menu"
  Pop $CB_StartMenu
  ${NSD_Check} $CB_StartMenu

  nsDialogs::Show
FunctionEnd

Function customOptionsPageLeave
  ${NSD_GetState} $CB_Desktop   $CB_Desktop
  ${NSD_GetState} $CB_Startup   $CB_Startup
  ${NSD_GetState} $CB_StartMenu $CB_StartMenu
FunctionEnd

; ── Post-install ──────────────────────────────────────────────────────────────
Function .onInstSuccess

  ${If} $CB_Desktop == ${BST_CHECKED}
    CreateShortcut "$DESKTOP\WorkTracker.lnk" "$INSTDIR\WorkTracker.exe" "" "$INSTDIR\WorkTracker.exe" 0
  ${Else}
    Delete "$DESKTOP\WorkTracker.lnk"
  ${EndIf}

  ${If} $CB_StartMenu == ${BST_CHECKED}
    CreateDirectory "$SMPROGRAMS\WorkTracker"
    CreateShortcut "$SMPROGRAMS\WorkTracker\WorkTracker.lnk" "$INSTDIR\WorkTracker.exe" "" "$INSTDIR\WorkTracker.exe" 0
    CreateShortcut "$SMPROGRAMS\WorkTracker\Uninstall WorkTracker.lnk" "$INSTDIR\Uninstall WorkTracker.exe"
  ${Else}
    Delete "$SMPROGRAMS\WorkTracker\WorkTracker.lnk"
    Delete "$SMPROGRAMS\WorkTracker\Uninstall WorkTracker.lnk"
    RMDir  "$SMPROGRAMS\WorkTracker"
  ${EndIf}

  ${If} $CB_Startup == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WorkTracker" '"$INSTDIR\WorkTracker.exe"'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WorkTracker"
  ${EndIf}

FunctionEnd

; ── Uninstaller cleanup ───────────────────────────────────────────────────────
Function un.onUninstSuccess
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WorkTracker"
  Delete "$DESKTOP\WorkTracker.lnk"
  Delete "$SMPROGRAMS\WorkTracker\WorkTracker.lnk"
  Delete "$SMPROGRAMS\WorkTracker\Uninstall WorkTracker.lnk"
  RMDir  "$SMPROGRAMS\WorkTracker"
FunctionEnd
