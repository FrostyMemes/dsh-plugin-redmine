param(
  [string]$DshCommand = 'E:\Programming\tools\DSH\resources\runtime\cli\bin\dsh.cmd',
  [int]$Port = 64620
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath $DshCommand)) { throw 'Укажите путь к dsh.cmd через -DshCommand.' }
$env:DSH_HOME = Join-Path $projectRoot '.dev\dsh-home'
$env:DSH_AGENTS_HOME = Join-Path $projectRoot '.dev\agents-home'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME,$env:DSH_AGENTS_HOME | Out-Null
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Сборка не выполнена; диагностика сохранена в .dev/build-diagnostics.json.' }
$profile = Join-Path $env:DSH_HOME 'profiles\redmine-dev'
if (-not (Test-Path -LiteralPath (Join-Path $profile 'package.json'))) {
  & $DshCommand --profile redmine-dev --from-default-profile web --help
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать изолированный профиль.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $profile 'node_modules\dsh-plugin-redmine'))) {
  & $DshCommand plugin --profile redmine-dev add "file:$projectRoot" --store-dir (Join-Path $projectRoot '.dev\pnpm-store') --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить Bundle в тестовый профиль.' }
}
& node scripts/sync-dev.mjs
if ($LASTEXITCODE -ne 0) { throw 'Не удалось обновить тестовую сборку.' }
$diagnosticsPath = (Join-Path $projectRoot '.dev\build-diagnostics.json').Replace('\','/')
$documentsDirectory = Join-Path $projectRoot '.dev\documents'
New-Item -ItemType Directory -Force -Path $documentsDirectory | Out-Null
$documentsPath = $documentsDirectory.Replace('\','/').Replace("'", "''")
$overlay = Join-Path $projectRoot '.dev\redmine-development.yml'
$yamlPath = $diagnosticsPath.Replace("'", "''")
@"
- id: redmine
  config:
    developmentDiagnosticsFile: '$yamlPath'
- id: workspace-controller
  config:
    documentsDirectory: '$documentsPath'
"@ | Set-Content -LiteralPath $overlay -Encoding utf8
Write-Host 'Изолированный DSH; моки включены при первом запуске. Ключи и MCP обычного профиля сюда не копируются.'
& $DshCommand --profile redmine-dev --patch $overlay --no-open --port $Port
