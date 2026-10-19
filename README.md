# Nequi

Web service (Node + Express) con base de datos Postgres. Entra con un código de 6 dígitos de un solo uso
generado por el admin.

- **Admin:** en la pantalla del código escribe `1090274993` (o el valor de la variable `ADMIN_KEY`).
  Desde ahí añades personas (nombre que sale en la app + celular que sale al entrar), generas códigos,
  y eliminas personas de la lista (eliminar NO cierra la sesión de quien ya entró).
- **Persona:** escribe su código una vez; el código se borra para siempre y la sesión queda guardada en
  ese dispositivo. En otro dispositivo el admin debe generar otro código («Nuevo código»).

## Desplegar en Render (paso a paso)

1. En [render.com](https://render.com) crea cuenta / inicia sesión y conecta tu GitHub (Account Settings → GitHub).
2. **Opción A – Blueprint (recomendada):** *New → Blueprint*, elige el repo `saaqes/nequi` y la rama
   (`main`, o `claude/practical-wozniak-eiyqn8` para probar). Render lee `render.yaml` y crea el web service
   `nequi` y la base de datos `nequi-db`. Cuando pida `ADMIN_KEY`, escribe `1090274993`. Pulsa *Apply*.
3. **Opción B – a mano:**
   1. *New → PostgreSQL*: nombre `nequi-db`, base `nequi`, plan Free. Cuando esté lista copia la
      **Internal Database URL**.
   2. *New → Web Service*: repo `saaqes/nequi`, Runtime **Node**, Build `npm install`, Start `npm start`.
   3. En *Environment* añade `DATABASE_URL` = la Internal Database URL, y `ADMIN_KEY` = `1090274993`.
4. Espera el deploy; abre la URL `https://nequi-xxxx.onrender.com`. Las tablas se crean solas al arrancar.
5. Entra con `1090274993`, añade personas y pásales su código.

Notas: el plan Free de Render duerme el servicio tras 15 min sin uso (la primera visita tarda ~30 s) y la base
gratis expira a los 30 días; para algo permanente usa un plan de pago.

## Desarrollo local

```
createdb nequi
DATABASE_URL=postgres://localhost:5432/nequi npm start
```
