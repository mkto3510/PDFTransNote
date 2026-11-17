; PDF TransNote のインストーラー（Inno Setup 7）
; ===========================================================================
; ポータブルアプリとして配る：
;   - 管理者権限なしで入れる（PrivilegesRequired=lowest）．置き場所は自由に選べる（USB メモリなども可）．
;   - アンインストーラーも「アプリと機能」への登録も作らず，レジストリに書かない．消すときはフォルダごと削除する．
;   - 設定などはアプリのフォルダの data\ に置く（アプリ側の仕組み）．上書きで入れ直しても data\ は残る．
; 作り方：build.ps1 から ISCC.exe /DAppVersion=0.1.0 installer\PdfTransNote.iss

#define AppName "PDF TransNote"
#define AppExe "PdfTransNote.exe"
#ifndef AppVersion
  #define AppVersion "0.1.0"
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
; ポータブル：権限・登録・アンインストーラー
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
UsePreviousAppDir=no
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
