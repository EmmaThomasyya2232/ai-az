$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$out = Join-Path $dir 'test-result.txt'
Remove-Item $out, (Join-Path $dir 'mock-requests.log') -ErrorAction SilentlyContinue

# 0. 清理旧进程
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 1. 启动 mock 上游 (9999)
Start-Process node -ArgumentList "`"$(Join-Path $dir 'mock-server.js')`"" -WindowStyle Hidden -WorkingDirectory $dir `
  -RedirectStandardOutput (Join-Path $dir 'mock-out.log') -RedirectStandardError (Join-Path $dir 'mock-err.log')

# 2. 启动 wrangler dev (8787)
Start-Process -FilePath (Join-Path $dir 'node_modules\.bin\wrangler.cmd') -ArgumentList 'dev','--port','8787' `
  -WindowStyle Hidden -WorkingDirectory $dir `
  -RedirectStandardOutput (Join-Path $dir 'wr-dev.log') -RedirectStandardError (Join-Path $dir 'wr-dev-err.log')

# 3. 等待就绪
Start-Sleep -Seconds 18
$lines = @()

# mock 自检
try {
  $mockResp = Invoke-RestMethod -Uri 'http://localhost:9999/self-test' -TimeoutSec 5
  $lines += "[1] mock-upstream: OK"
} catch {
  $lines += "[1] mock-upstream: DOWN ($($_.Exception.Message))"
}

# 通过网关发起推理请求 (stream=false)
try {
  $body = '{"model":"gpt-4o","stream":false,"messages":[{"role":"user","content":"hello"}]}'
  $resp = Invoke-RestMethod -Uri 'http://localhost:8787/v1/chat/completions' -Method Post `
    -Headers @{ Authorization = 'Bearer sk-az-local-test-key' } `
    -ContentType 'application/json' -Body $body -TimeoutSec 20
  $lines += "[2] gateway->upstream echo:"
  $lines += ($resp | ConvertTo-Json -Compress)
} catch {
  $lines += "[2] gateway POST FAILED: $($_.Exception.Message)"
}

# 读取 mock 收到的请求记录
$lines += "[3] mock-requests.log content:"
if (Test-Path (Join-Path $dir 'mock-requests.log')) {
  $lines += (Get-Content (Join-Path $dir 'mock-requests.log') -Raw)
} else {
  $lines += "(empty - mock received nothing)"
}

$lines | Out-File $out -Encoding utf8
"TEST-FINISHED" | Out-File (Join-Path $dir 'test-done.flag') -Encoding ascii
