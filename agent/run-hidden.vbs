' Run run-production.cmd without a window.
' Put a shortcut to this file in the Windows Startup folder to start the agent at logon.
' Safe to run more than once: does nothing if the agent loop is already running.
' Keep this file ASCII only: VBScript reads it in the system codepage.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set running = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'cmd.exe' AND CommandLine LIKE '%run-production.cmd%'")
If running.Count > 0 Then WScript.Quit 0

CreateObject("WScript.Shell").Run """" & dir & "\run-production.cmd""", 0, False
