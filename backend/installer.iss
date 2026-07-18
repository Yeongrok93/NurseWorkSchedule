[Setup]
AppId={{B7E1D3A2-8F4C-4D2E-9A31-DUTY2026KR}}
AppName=간호사 듀티표 생성기
AppVersion=1.0.0
AppPublisher=NRICU
DefaultDirName={localappdata}\듀티표생성기
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=installer
OutputBaseFilename=듀티표생성기_설치
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=간호사 듀티표 생성기

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "dist\듀티표생성기\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{userdesktop}\듀티표 생성기"; Filename: "{app}\듀티표생성기.exe"
Name: "{userprograms}\듀티표 생성기"; Filename: "{app}\듀티표생성기.exe"

[Run]
Filename: "{app}\듀티표생성기.exe"; Description: "지금 실행"; Flags: postinstall nowait skipifsilent
