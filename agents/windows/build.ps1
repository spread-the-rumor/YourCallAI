# Builds the Windows name agent into agents/dist (requires .NET 8 SDK)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
dotnet publish "$PSScriptRoot\YourCallAgent.csproj" -c Release -o "$root\agents\dist"
Get-ChildItem "$root\agents\dist" -Exclude YourCallAgent.exe,.gitkeep | Remove-Item -Recurse -Force
