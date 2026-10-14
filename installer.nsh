!include "getProcessInfo.nsh"
Var pid

!macro customHeader
  !undef UNINSTALL_FILENAME
  !define UNINSTALL_FILENAME "uninstaller.exe"
!macroend

; Repair only the two published uninstallers whose generated PE header failed CRC.
; Keep their registered paths so the normal NSIS upgrade flow can remove the old app.
!macro repairKnownUninstaller ROOT_KEY
  Push $0
  Push $1
  Push $2
  Push $3
  ReadRegStr $0 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $1 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $0 != ""
    Push "$1"
    Call GetInQuotes
    Pop $2
    ${If} $2 == "$0\Uninstall ${PRODUCT_FILENAME}.exe"
    ${AndIf} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
    ${AndIf} ${FileExists} "$0\resources\app.asar"
      ${StdUtils.HashFile} $3 "SHA2-256" "$2"
      ${If} $3 == "63af08cc2993453c8e0d921dc9ee58fd79c394fccea880e7127e8d6d67e0b927"
      ${OrIf} $3 == "ce180d078f43e81ddb02349de84a5cef02fd30ee9ead1fbbb2f835afc8a3be0a"
        InitPluginsDir
        SetOutPath "$PLUGINSDIR"
        File /oname=recovery-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
        ClearErrors
        CopyFiles /SILENT "$PLUGINSDIR\recovery-uninstaller.exe" "$2"
        ${If} ${Errors}
          MessageBox MB_OK|MB_ICONSTOP "Cannot repair the previous uninstaller. Close Study Workbench and retry.$\r$\n无法修复旧版卸载器。请关闭学习工作台后重试。"
          SetErrorLevel 2
          Quit
        ${EndIf}
        DetailPrint "Previous uninstaller repaired / 已修复旧版卸载器"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro repairKnownUninstaller SHELL_CONTEXT
    ${If} $installMode == "all"
      !insertmacro repairKnownUninstaller HKCU
    ${EndIf}
  !endif
!macroend

; Assisted per-machine installs skip CHECK_APP_RUNNING in the elevated instance.
!macro customInit
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${UAC_IsAdmin}
    !insertmacro repairKnownUninstaller HKLM
    !insertmacro repairKnownUninstaller HKCU
  ${EndIf}
!macroend
