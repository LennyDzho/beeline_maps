param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$JavaHome = $env:JAVA_HOME,
    [switch]$DeviceTests,
    [switch]$CompileDeviceTests
)
$ErrorActionPreference = 'Stop'
if (-not $JavaHome) { $JavaHome = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr' }
if (-not $AndroidSdk) { $AndroidSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) {
    throw 'JDK 17 not found. Set JAVA_HOME or pass -JavaHome.'
}
if (-not (Test-Path -LiteralPath (Join-Path $AndroidSdk 'platforms\android-34\android.jar'))) {
    throw 'Android SDK platform 34 not found. Install it in Android Studio, or pass -AndroidSdk.'
}
$previousJavaHome = $env:JAVA_HOME
$previousAndroidHome = $env:ANDROID_HOME
$previousPath = $env:PATH
$buildRoot = $PSScriptRoot
$stagingRoot = $null
if ($PSScriptRoot -match '[^\x00-\x7F]') {
    $stagingRoot = Join-Path ([IO.Path]::GetTempPath()) ('marshrut-android-' + [guid]::NewGuid().ToString('N'))
    if ($stagingRoot -match '[^\x00-\x7F]') { throw 'Android build needs an ASCII path. Set TEMP to an ASCII directory.' }
    New-Item -ItemType Directory -Path $stagingRoot | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stagingRoot 'app') | Out-Null
    foreach ($sourceFile in @('settings.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'gradlew', 'gradlew.bat')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $sourceFile) -Destination $stagingRoot
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gradle') -Destination $stagingRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'app\build.gradle.kts') -Destination (Join-Path $stagingRoot 'app')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'app\src') -Destination (Join-Path $stagingRoot 'app') -Recurse
    $buildRoot = $stagingRoot
    Write-Output 'Building an isolated source snapshot in an ASCII temporary path.'
}
try {
    $env:JAVA_HOME = $JavaHome
    $env:ANDROID_HOME = $AndroidSdk
    # AGP inherits PATH into java.library.path. Embedded quotes break Windows JVM workers.
    $env:PATH = $env:PATH.Replace('"', '')
    Push-Location $buildRoot
    try {
        $buildTasks = @(':app:assembleDebug', ':app:testDebugUnitTest', ':app:lintDebug')
        if ($CompileDeviceTests) { $buildTasks += ':app:assembleDebugAndroidTest' }
        if ($DeviceTests) { $buildTasks += ':app:connectedDebugAndroidTest' }
        & '.\gradlew.bat' @buildTasks '--console=plain' '--no-daemon' '--continue'
        $buildExitCode = $LASTEXITCODE
        if ($stagingRoot) {
            $projectBuild = Join-Path $PSScriptRoot 'app\build'
            New-Item -ItemType Directory -Force -Path $projectBuild | Out-Null
            foreach ($artifactDir in @('outputs', 'reports', 'test-results')) {
                $sourceArtifacts = Join-Path $stagingRoot ('app\build\' + $artifactDir)
                if (Test-Path -LiteralPath $sourceArtifacts) {
                    Copy-Item -LiteralPath $sourceArtifacts -Destination $projectBuild -Recurse -Force
                }
            }
        }
        if ($buildExitCode -ne 0) { throw "Android build failed with exit code $buildExitCode. Reports are in app/build/reports." }
        Write-Output (Join-Path $PSScriptRoot 'app\build\outputs\apk\debug\app-debug.apk')
    } finally { Pop-Location }
} finally {
    $env:JAVA_HOME = $previousJavaHome
    $env:ANDROID_HOME = $previousAndroidHome
    $env:PATH = $previousPath
    if ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
        $resolvedStage = [IO.Path]::GetFullPath($stagingRoot)
        $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if ($resolvedStage.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedStage) -match '^marshrut-android-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
