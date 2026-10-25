$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\_Project\Leprechaun'
& python swarm_master.py --ignore-command --tickers NVDA AMD TSM AVGO MU MRVL ORCL CIEN GLW PLTR SOFI INTC QCOM
exit $LASTEXITCODE
