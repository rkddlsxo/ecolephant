$ErrorActionPreference = "Stop"

$TargetReplicas = 2
$ScaleUpReplicas = $TargetReplicas * 2

$OldContainers = @(docker compose ps -q backend | Where-Object { $_ -ne "" })
if ($OldContainers.Count -eq 0) {
    docker compose up -d --build
    exit 0
}

docker compose build backend
docker compose up -d --no-deps --scale "backend=$ScaleUpReplicas" --no-recreate backend

$AllContainers = @(docker compose ps -q backend | Where-Object { $_ -ne "" })
foreach ($cid in $AllContainers) {
    $healthy = $false
    for ($i = 1; $i -le 30; $i++) {
        $status = (docker inspect --format="{{.State.Health.Status}}" $cid 2>$null)
        if ($status -eq "healthy") {
            $healthy = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) {
        throw "Healthcheck failed for container: $cid"
    }
}

docker compose exec -T web nginx -s reload
foreach ($oldId in $OldContainers) {
    docker stop $oldId | Out-Null
    docker rm -f $oldId | Out-Null
}

docker compose exec -T web nginx -s reload
$response = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get
Write-Host ($response | ConvertTo-Json -Compress)
