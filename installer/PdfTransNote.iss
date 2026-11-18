; PDF TransNote のインストーラー（Inno Setup 7）
; ===========================================================================
; 方針：
;   - 管理者権限なしで入れる（PrivilegesRequired=lowest）．置き場所は自由に選べる．
;   - アンインストーラーを作り，今のユーザーの範囲（HKCU）だけに登録する．Windows の「設定 → アプリ」から消せる．
;   - 設定などはアプリのフォルダの data\ に置く（アプリ側の仕組み）．上書きで入れ直しても data\ は残る．
;     アンインストールのときは，data\ も消すかを尋ねる（既定は「残す」．サイレントのときは尋ねずに残す）．
;   - レジストリをまったく使わないポータブル版は，build.ps1 が作る zip のほう．
; 作り方：build.ps1 から ISCC.exe /DAppVersion=0.3.2 installer\PdfTransNote.iss

#define AppName "PDF TransNote"
#define AppExe "PdfTransNote.exe"
#ifndef AppVersion
  #define AppVersion "0.3.2"
#endif
#define SourceDir "..\dist\PdfTransNote"

[Setup]
AppId={{8A456271-14CB-40AA-8592-B8B6A04686CF}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
; 権限とアンインストーラー（HKCU に登録）
PrivilegesRequired=lowest
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
; 更新のときは前と同じフォルダに入れる
UsePreviousAppDir=yes
UsePreviousGroup=no
UsePreviousTasks=no
UsePreviousSetupType=no
UsePreviousLanguage=no
DefaultDirName={userpf}\{#AppName}
DirExistsWarning=no
DisableProgramGroupPage=yes
AllowNoIcons=yes
; 64 ビット
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 見た目と出力
WizardStyle=modern
SetupIconFile=..\assets\PdfTransNote.ico
InfoAfterFile=after-install.txt
OutputDir=..\release
OutputBaseFilename=PdfTransNote-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
; 動いている PDF TransNote があれば閉じてから入れ替える
CloseApplications=yes
; アプリが動いていれば，インストールとアンインストールの前に閉じるよう求める（transnote/app.py の APP_MUTEX）
AppMutex=PdfTransNote.AppMutex
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startmenuicon"; Description: "Create a Start menu shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[InstallDelete]
; 入れ直すときに古い部品が残らないよう，同梱物のフォルダを消してから入れる（data\ は消さない）
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "data,data\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startmenuicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
// Microsoft Edge WebView2 ランタイム（画面の表示に使う）があるかを確かめる．Windows 11 には標準で入っている．
// 読むだけで，レジストリには書かない．
const
  WebView2Key = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2: Boolean;
var
  V: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  if not HasWebView2 then
    Result := MsgBox(
      'The Microsoft Edge WebView2 Runtime was not found.' + #13#10 +
      'It is required to display the PDF TransNote window.' + #13#10 +
      'Please install it from https://developer.microsoft.com/microsoft-edge/webview2/' + #13#10#13#10 +
      'Continue anyway?', mbConfirmation, MB_YESNO) = IDYES;
end;

// アンインストールの最後に，設定とバックアップ（data）も消すかを尋ねる．
// 代わりの置き場所 %LOCALAPPDATA%\PdfTransNote（transnote/paths.py の data_dir()）も対象にする．
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppData, LocalData, Found: String;
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;
  AppData := ExpandConstant('{app}\data');
  LocalData := ExpandConstant('{localappdata}\PdfTransNote');
  Found := '';
  if DirExists(AppData) then
    Found := Found + #13#10 + '  ' + AppData;
  if DirExists(LocalData) then
    Found := Found + #13#10 + '  ' + LocalData;
  if (Found <> '') and not UninstallSilent then
  begin
    if MsgBox('Also delete your settings and PDF backups?' + #13#10 + Found + #13#10#13#10 +
      'Settings include API keys. Choose No to keep them for a later reinstall.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      if DirExists(AppData) then
        DelTree(AppData, True, True, True);
      if DirExists(LocalData) then
        DelTree(LocalData, True, True, True);
    end;
  end;
  RemoveDir(ExpandConstant('{app}'));
end;
