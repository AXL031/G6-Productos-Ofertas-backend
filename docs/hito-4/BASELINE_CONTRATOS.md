# Línea base contractual H4

- Backend master: `b061ef86ec63a06ba626c3f7a66c94cd7fc270db` (PR #221).
- Docs master: `aba8d1ca998cfcd2db1c4fa87654036a5a4c1ac1` (OpenAPI 0.6.0-rc.3, AsyncAPI 0.6.0-rc.4).
- Frontend H4: `520366d5d4766d9a173269d43e1ee34e7d6b5cbf`. Frontend master: `f9c494ae1c23e7107c8b1c41c4af9f2ad40fca09`.

`baseline-contratos.json` conserva las definiciones estructurales de Docs con sus referencias, el registro ejecutable de Gateway y los blobs de controladores del commit base. Los contratos de Docs y la tabla de Gateway se registran por separado para conservar cualquier diferencia preexistente. Los blobs permiten recuperar el handler exacto con `git show <blob>`. La captura identifica código fuente y contratos, y la matriz de verificación registra la evidencia de ejecución por separado.

Para reproducir, usar Node 24, Python con PyYAML y los dos checkouts en los SHA indicados. Desde la raíz del backend ejecutar:

```powershell
python docs/hito-4/capturar-contratos.py <checkout-docs> <salida.json>
```

La comparación [pre/post de Gateway](compatibilidad-gateway.json) verifica las 135 entradas del registro principal y la entrada condicional de fase 1. Las ocho adiciones son siete lecturas humanas y un POST administrativo recuperable. El OpenAPI de referencia contiene 136 operaciones y AsyncAPI 40 canales. `obtenerContextoSku` está en el registro interno de fase 1, fuera del registro principal. Ejecutar `node docs/hito-4/verificar-compatibilidad.mjs` para repetir la comparación.
