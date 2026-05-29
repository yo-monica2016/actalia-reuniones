# Login y usuarios

## Configuración inicial (una vez)

### 1. `server/.env`

Añade (o copia de `server/.env.example`):

```env
JWT_SECRET=una-cadena-aleatoria-minimo-32-caracteres-cambiala
JWT_EXPIRES_IN=7d
```

Guarda el archivo.

### 2. Base de datos

Al arrancar el API (`npm run dev` en `server/`), se crean/actualizan:

- Tabla `usuarios` (con columna `rol`: `admin` | `usuario`)
- Columna `reuniones.usuario_id`

También puedes ejecutar manualmente `server/sql/add_auth.sql` en phpMyAdmin.

### 3. Primer administrador

En PowerShell:

```powershell
cd c:\laragon\www\actalia-reuniones\server
npm run crear-usuario -- admin@tuempresa.com TU_CONTRASEÑA "Nombre Admin" admin
```

- **La contraseña** es la que escribes en `TU_CONTRASEÑA` (tú la eliges).
- Ese email y contraseña son los de la pantalla de login.

### 4. Arrancar la aplicación

Terminal 1 (API):

```powershell
cd c:\laragon\www\actalia-reuniones\server
npm run dev
```

Terminal 2 (web):

```powershell
cd c:\laragon\www\actalia-reuniones
npm run dev
```

Abre la URL de Vite (ej. http://localhost:5173).

---

## Roles

| Rol | Reuniones |
|-----|-----------|
| **admin** | Ve y gestiona **todas** las reuniones |
| **usuario** | Solo las reuniones que **él creó** (`usuario_id` suyo) |

El admin puede crear más usuarios desde el panel **Usuarios** (columna izquierda).

---

## Cómo comprobar que funciona

### Login

1. Entra con el admin creado → debe aparecer la app (no la pantalla de login).
2. Arriba a la derecha: tu nombre y botón **Salir**.
3. Pulsa **Salir** → vuelve el login.
4. Credenciales incorrectas → mensaje de error en rojo.

### Admin ve todo

1. Como admin, crea una reunión «Prueba admin».
2. Crea un usuario normal (panel Usuarios):  
   `usuario@test.com` / contraseña / rol **Usuario**.
3. Cierra sesión. Entra como `usuario@test.com`.
4. Crea reunión «Prueba usuario».
5. En la lista solo debe verse «Prueba usuario» (no la del admin).
6. Cierra sesión. Entra como admin → deben verse **ambas** reuniones.

### API protegida

Sin token, en el navegador o con curl:

```text
GET http://127.0.0.1:3001/api/reuniones
```

→ **401** `no autorizado`

`GET http://127.0.0.1:3001/health` sigue siendo público.

---

## Reuniones antiguas (sin `usuario_id`)

Las reuniones creadas antes del login tienen `usuario_id` NULL. El **admin** las sigue viendo. Los **usuarios** no las ven hasta asignarlas, por ejemplo en phpMyAdmin:

```sql
UPDATE reuniones SET usuario_id = 1 WHERE usuario_id IS NULL;
```

(sustituye `1` por el id del admin si procede).

---

## Qué te falta por hacer tú

| Paso | Hecho por ti |
|------|----------------|
| `JWT_SECRET` en `server/.env` | ☐ Añadir y guardar |
| Reiniciar `npm run dev` (server) | ☐ Tras cambiar `.env` |
| `npm run crear-usuario` (primer admin) | ☐ Elegir email y contraseña |
| Probar login y dos roles | ☐ Checklist arriba |
| OpenAI (interpretar / transcribir) | ☐ Sigue necesitando cuota en la cuenta de la API key |
