New-NetFirewallRule -DisplayName "Dev Server" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
