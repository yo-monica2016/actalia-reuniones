# Desarrollo local

## Terminales

**API (puerto 3001):**
```powershell
cd server
npm run dev
```

**Web (Vite, puerto 5173 o el siguiente libre — p. ej. 5174):**
```powershell
cd ..
npm run dev
```

Abre la URL que muestre Vite (`http://localhost:5173` o `http://localhost:5174`).

## Conexión frontend ↔ API

- En `.env` de la raíz: `VITE_API_URL=` (vacío).
- Las peticiones van a rutas relativas (`/api/...`, `/health`) y **Vite las reenvía** a `http://127.0.0.1:3001`.
- **No importa** si Vite usa 5173, 5174 o 5175: el API sigue en **3001**.

Si el puerto 5173 está ocupado, cierra el proceso viejo o usa directamente la URL que indique Vite (5174).

## Subir audio

1. Terminal del **server** visible.
2. Subir archivo en la app.
3. En el **server** debe aparecer `[http] --> POST /api/reuniones/.../audio`.
4. En la terminal de **Vite** puede aparecer `[vite-proxy] POST /api → http://127.0.0.1:3001`.

## Puerto 5173 ocupado

```powershell
Get-NetTCPConnection -LocalPort 5173 | Select-Object OwningProcess
Stop-Process -Id <PID> -Force
```

Luego `npm run dev` en la raíz del proyecto.
