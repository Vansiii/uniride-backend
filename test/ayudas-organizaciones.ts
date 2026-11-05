import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import request from 'supertest';
import { AplicacionModule } from '../src/aplicacion.module.js';
import { configurarAplicacion } from '../src/configurar-aplicacion.js';
import { CorreosService } from '../src/notificaciones/correos.service.js';

/** Todo lo que crean estas pruebas lleva este sufijo o prefijo, para limpiarlo sin tocar otros datos. */
export const DOMINIO = '@hu01.test';
export const PREFIJO = 'HU01 ';
export const CONTRASENA = 'Clave1234';
/** También los subdominios (`ana@a.hu01.test`), que el registro de HU-05 usa como dominios de organización. */
const CORREOS = `%${DOMINIO.slice(1)}`;

export interface Entorno {
  app: INestApplication;
  bd: pg.Client; // rol dueño: prepara y limpia datos
  correos: CorreosService;
  api: () => ReturnType<typeof request>;
  /** Cabecera de sesión de un usuario creado en BD. */
  iniciar: (correo: string) => Promise<string>;
  crearUsuario: (correo: string, rol?: string) => Promise<string>;
  limpiar: () => Promise<void>;
  cerrar: () => Promise<void>;
}

export async function prepararEntorno(): Promise<Entorno> {
  process.env.JWT_ACCESO_SECRETO ??= 'secreto-de-pruebas';
  process.env.CORREO_MODO = 'consola';
  process.env.OTP_SECRETO ||= 'secreto-otp-de-pruebas';
  process.env.IDENTIDAD_SECRETO ||= 'secreto-identidad-de-pruebas';
  const bd = new pg.Client({
    connectionString: process.env.DATABASE_URL_MIGRACIONES,
  });
  await bd.connect();
  const modulo = await Test.createTestingModule({
    imports: [AplicacionModule],
  }).compile();
  const app = modulo.createNestApplication();
  configurarAplicacion(app);
  await app.init();
  const api = () => request(app.getHttpServer());

  const limpiar = async () => {
    const orgs = `SELECT id FROM organizaciones WHERE nombre LIKE '${PREFIJO}%'`;
    const usuarios = `SELECT id FROM usuarios WHERE correo LIKE '${CORREOS}'`;
    const codigos = `SELECT id::text FROM codigos_otp WHERE correo LIKE '${CORREOS}'`;
    await bd.query(
      `DELETE FROM correos_salientes WHERE destinatario LIKE '${CORREOS}'`,
    );
    await bd.query(
      `DELETE FROM registros_auditoria WHERE entidad = 'codigo_otp' AND entidad_id IN (${codigos})`,
    );
    await bd.query(`DELETE FROM codigos_otp WHERE correo LIKE '${CORREOS}'`);
    // HU-34: las solicitudes sin cuenta se auditan solo con el dominio.
    await bd.query(
      `DELETE FROM registros_auditoria WHERE accion LIKE 'recuperacion.%' AND detalle->>'dominio' LIKE '${CORREOS}'`,
    );
    await bd.query(
      `DELETE FROM registros_auditoria WHERE organizacion_id IN (${orgs}) OR actor_id IN (${usuarios})`,
    );
    await bd.query(`DELETE FROM membresias WHERE organizacion_id IN (${orgs})`);
    await bd.query(
      `DELETE FROM dominios_organizacion WHERE organizacion_id IN (${orgs})`,
    );
    await bd.query(
      `DELETE FROM invitaciones WHERE organizacion_id IN (${orgs})`,
    );
    await bd.query(
      `DELETE FROM organizaciones WHERE nombre LIKE '${PREFIJO}%'`,
    );
    await bd.query(
      `DELETE FROM tokens_refresco WHERE usuario_id IN (${usuarios})`,
    );
    await bd.query(
      `DELETE FROM vehiculos WHERE propietario_id IN (${usuarios})`,
    );
    await bd.query(`DELETE FROM identidades WHERE usuario_id IN (${usuarios})`);
    await bd.query(`DELETE FROM usuarios WHERE correo LIKE '${CORREOS}'`);
  };
  await limpiar();

  return {
    app,
    bd,
    correos: app.get(CorreosService),
    api,
    crearUsuario: async (correo, rol) => {
      const { rows } = await bd.query(
        `INSERT INTO usuarios (correo, hash_contrasena, nombre_completo, rol_plataforma) VALUES ($1, $2, 'Prueba', $3) RETURNING id`,
        [correo, await bcrypt.hash(CONTRASENA, 4), rol ?? null],
      );
      return rows[0].id;
    },
    iniciar: async (correo) => {
      const r = await api()
        .post('/api/v1/autenticacion/iniciar-sesion')
        .send({ correo, contrasena: CONTRASENA, tipoCliente: 'movil' })
        .expect(200);
      return r.body.tokenAcceso;
    },
    limpiar,
    cerrar: async () => {
      await limpiar();
      await bd.end();
      await app.close();
    },
  };
}

/** El token solo existe en el enlace del correo en cola (en BD solo queda su hash). */
export async function tokenInvitacion(bd: pg.Client, correo: string) {
  const { rows } = await bd.query(
    `SELECT datos->>'enlace' AS enlace FROM correos_salientes WHERE destinatario = $1 ORDER BY creado_en DESC LIMIT 1`,
    [correo],
  );
  return String(rows[0].enlace).split('/').pop() as string;
}

/** Da de alta la organización y acepta la invitación: devuelve su id, el usuario admin y su token (con `org`). */
export async function organizacionConAdmin(
  e: Entorno,
  superToken: string,
  sufijo: string,
) {
  const cuerpo = alta(sufijo);
  const r = await e
    .api()
    .post('/api/v1/admin/organizaciones')
    .set({ Authorization: `Bearer ${superToken}` })
    .send(cuerpo)
    .expect(201);
  const token = await tokenInvitacion(e.bd, cuerpo.adminCorreo);
  const aceptada = await e
    .api()
    .post(`/api/v1/invitaciones/${token}/aceptar`)
    .send({
      nombreCompleto: 'Admin',
      contrasena: CONTRASENA,
      tipoCliente: 'movil',
    })
    .expect(200);
  const { rows } = await e.bd.query(
    `SELECT id FROM usuarios WHERE correo = $1`,
    [cuerpo.adminCorreo],
  );
  return {
    id: r.body.id as string,
    adminId: rows[0].id as string,
    token: aceptada.body.tokenAcceso as string,
  };
}

/** Organización con admin y un dominio de correo (`<letra>.hu01.test`) para el registro de HU-05. */
export async function organizacionConDominio(
  e: Entorno,
  superToken: string,
  sufijo: string,
  dominio: string,
  modoAprobacion: 'manual' | 'automatica',
) {
  const org = await organizacionConAdmin(e, superToken, sufijo);
  await e
    .api()
    .put(`/api/v1/organizaciones/${org.id}/afiliacion`)
    .set({ Authorization: `Bearer ${org.token}` })
    .send({ dominios: [dominio], modoAprobacion })
    .expect(200);
  return org;
}

/** Captura los correos enviados en el momento (OTP); `codigoPara` lee el último código de ese correo. */
export function buzon(e: Entorno) {
  const enviados: { para: string; asunto: string; texto: string }[] = [];
  e.correos.enviador = {
    enviar: async (para, c) => {
      enviados.push({ para, ...c });
    },
  };
  const codigoPara = (para: string) => {
    const ultimo = enviados.filter((c) => c.para === para).pop();
    return ultimo?.texto.match(/\b\d{6}\b/)?.[0];
  };
  return { enviados, codigoPara };
}

/** Usuario con membresía en la organización (activa en su próxima sesión); devuelve su token. */
export async function miembroCon(
  e: Entorno,
  organizacionId: string,
  correo: string,
  estado: 'aprobada' | 'pendiente' | 'rechazada',
  rol: 'miembro' | 'admin_organizacion' = 'miembro',
) {
  const id = await e.crearUsuario(correo);
  await e.bd.query(
    `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado) VALUES ($1, $2, $3, $4)`,
    [organizacionId, id, rol, estado],
  );
  await e.bd.query(
    `UPDATE usuarios SET ultima_organizacion_id = $1 WHERE id = $2`,
    [organizacionId, id],
  );
  return e.iniciar(correo);
}

export const alta = (sufijo: string, extra: object = {}) => ({
  nombre: `${PREFIJO}${sufijo}`,
  tipo: 'universidad',
  precioMaximoUrc: 20,
  adminNombre: 'Ana Admin',
  adminCorreo: `admin.${sufijo.toLowerCase().replace(/\W/g, '')}${DOMINIO}`,
  ...extra,
});
