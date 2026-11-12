# Builds the Windows name agent into agents/dist (requires .NET 8 SDK)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
dotnet publish "$PSScriptRoot\YourCallAgent.csproj" -c Release -o "$root\agents\dist"
# A native command's failure does not trip ErrorActionPreference; without this the cleanup below
# ran anyway and CI shipped an installer with no agent.
if ($LASTEXITCODE -ne 0) { Write-Error "dotnet publish failed ($LASTEXITCODE)"; exit $LASTEXITCODE }
if (-not (Test-Path "$root\agents\dist\YourCallAgent.exe")) { Write-Error 'YourCallAgent.exe was not produced'; exit 1 }
Get-ChildItem "$root\agents\dist" -Exclude YourCallAgent.exe,.gitkeep | Remove-Item -Recurse -Force
