' Launch the cursor-bridge daemon loop in a hidden window.
' Resolves run-server.cmd relative to this script so it works from any path.
Dim fso, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run """" & scriptDir & "\run-server.cmd""", 0, False
