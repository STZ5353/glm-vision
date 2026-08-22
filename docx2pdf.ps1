# docx2pdf.ps1 - Convert Word document to PDF via Word COM automation
# (glm-vision v2.0 helper script; called by glm-vision.ts with a 90s timeout)
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File docx2pdf.ps1 <input.docx|.doc> <output.pdf>
#
# Notes:
#  - Word is launched hidden; macros are force-disabled (AutomationSecurity=3)
#    to avoid security prompts blocking the conversion.
#  - Prints the output path on success, exits non-zero on failure.
#  - Keep this file ASCII-only: PowerShell 5.1 reads BOM-less files as ANSI.

param(
    [Parameter(Mandatory = $true)][string]$Src,
    [Parameter(Mandatory = $true)][string]$Dst
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # stderr to UTF-8 for the caller
$word = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3   # msoAutomationSecurityForceDisable
    $doc = $word.Documents.Open($Src, $false, $true)  # ReadOnly, AddToRecentFiles=false
    $doc.SaveAs2($Dst, 17)                            # 17 = wdFormatPDF
    $doc.Close($false)
    Write-Output $Dst
} catch {
    Write-Error "Word conversion failed: $($_.Exception.Message)"
    exit 1
} finally {
    if ($word -ne $null) {
        try { $word.Quit() } catch {}
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    }
}
