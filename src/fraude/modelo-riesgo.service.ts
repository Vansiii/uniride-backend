import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { distanciaM } from '../presencia/geo.js';
import { buscarAnillos, type Arista } from './anillos.js';
import {
  aFila,
  entrenarModelo,
  evaluarPar,
  MINIMO_PARES,
  redondear,
  riesgoDe,
  UMBRAL_ALERTA,
  type CifrasPar,
  type ClaveCifra,
  type Factor,
  type Modelo,
} from './cifras-par.js';
import { evaluar, type Validacion } from './escenarios.js';
import { DIA_MS, ordenarPar } from './patrones.js';

export const VIGENCIA_MODELO_MS = DIA_MS;
export const SIN_REPETIR_MS = 7 * DIA_MS;

export interface ParOrganizacion {
  /** Ordenadas, como en las alertas de HU-25. */
  personas: [string, string];
  cifras: CifrasPar;
}

export interface DatosOrganizacion {
  pares: ParOrganizacion[];
  aristas: Arista[];
  totales: Map<string, number>;
}

export interface PuntajeModelo {
  puntaje: number;
  riesgo: 'bajo' | 'medio' | 'alto';
  factores: Factor[];
  percentiles: Record<ClaveCifra, number>;
  version: number;
}

export interface ResumenModelo {
  entrenadas: number;
  sinDatos: number;
  alertas: number;
}

interface RegistroModelo {
  version: number;
  semilla: number;
  pares: number;
  filas: number[][];
  histograma: number[];
  creado_en: Date;
}

const clavePar = (a: string, b: string) => ordenarPar(a, b).join(':');

/** Semilla reproducible por organización y día. */
function semillaDe(organizacionId: string, ahora: Date): number {
  let h = 2166136261;
  for (const c of `${organizacionId}:${ahora.toISOString().slice(0, 10)}`)
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * PB-11: modelo de riesgo propio por organización (RN-2). Cada `MODELO_RIESGO_INTERVALO_MS` busca organizaciones sin
 * modelo de las últimas 24 h, entrena con sus pares, crea alertas de comportamiento atípico y de anillos. Nunca crea
 * bloqueos ni toca reservas, viajes o saldos (RN-1, CA-12): solo escribe en la auditoría.
 */
@Injectable()
export class ModeloRiesgoService implements OnModuleInit, OnModuleDestroy {
  private readonly registro = new Logger(ModeloRiesgoService.name);
  private temporizador?: NodeJS.Timeout;
  private arranque?: NodeJS.Timeout;
  private ocupado = false;
  private readonly cache = new Map<
    string,
    { version: number; modelo: Modelo }
  >();
  private validacionCache?: Validacion;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const ms = Number(process.env.MODELO_RIESGO_INTERVALO_MS) || 3_600_000;
    this.temporizador = setInterval(() => void this.tic(), ms);
    this.arranque = setTimeout(() => void this.tic(), 15_000);
  }

  onModuleDestroy(): void {
    if (this.temporizador) clearInterval(this.temporizador);
    if (this.arranque) clearTimeout(this.arranque);
  }

  private async tic(): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      await this.entrenarPendientes();
    } catch (error) {
      this.registro.error('Error en el tic del modelo de riesgo', error);
    } finally {
      this.ocupado = false;
    }
  }

  /** CA-11: validación con escenarios simulados; se calcula una vez (son datos fijos, no reales). */
  validacion(): Validacion {
    return (this.validacionCache ??= evaluar());
  }

  /** Las pruebas lo invocan a mano, limitado a su organización y con una fecha arbitraria. */
  async entrenarPendientes(
    soloOrganizacion: string | null = null,
    ahora: Date = new Date(),
  ): Promise<ResumenModelo> {
    const resumen: ResumenModelo = { entrenadas: 0, sinDatos: 0, alertas: 0 };
    const desde = new Date(ahora.getTime() - VIGENCIA_MODELO_MS);
    const organizaciones = await this.prisma.comoSuperAdmin(
      (tx) => tx.$queryRaw<{ id: string }[]>`
        SELECT o.id FROM organizaciones o
        WHERE (${soloOrganizacion}::uuid IS NULL OR o.id = ${soloOrganizacion}::uuid)
          AND NOT EXISTS (SELECT 1 FROM registros_auditoria x
            WHERE x.accion = 'fraude.modelo' AND x.organizacion_id = o.id AND x.creado_en > ${desde})
        ORDER BY o.id`,
    );
    for (const { id } of organizaciones) {
      try {
        const r = await this.entrenarOrganizacion(id, ahora);
        if (r === null) continue;
        if (r < 0) resumen.sinDatos++;
        else {
          resumen.entrenadas++;
          resumen.alertas += r;
        }
      } catch (error) {
        this.registro.error(
          `Modelo de riesgo: falló la organización ${id}: ${(error as Error).name}`,
        );
        // Se conserva el modelo anterior; la falla queda en auditoría y se reintenta en el siguiente tic.
        await this.auditoria
          .registrar({
            accion: 'fraude.modelo.error',
            entidad: 'organizacion',
            entidadId: id,
            resultado: 'fallo',
            organizacionId: id,
            detalle: { motivo: (error as Error).name },
          })
          .catch(() => undefined);
      }
    }
    return resumen;
  }

  /** Devuelve las alertas creadas, -1 si no hubo datos suficientes o `null` si otro proceso ya lo hizo (CA-16). */
  private async entrenarOrganizacion(
    organizacionId: string,
    ahora: Date,
  ): Promise<number | null> {
    const datos = await this.prisma.enOrganizacion(organizacionId, (tx) =>
      this.datosOrganizacion(tx, organizacionId, ahora),
    );
    const confirmados = await this.prisma.enOrganizacion(organizacionId, (tx) =>
      this.confirmados(tx, organizacionId),
    );
    // CA-9: lo confirmado como fraude no se aprende como normal.
    const entrenamiento = datos.pares.filter((p) => !confirmados(p.personas));
    const desde = new Date(ahora.getTime() - VIGENCIA_MODELO_MS);
    const semilla = semillaDe(organizacionId, ahora);

    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fraude.modelo:${organizacionId}`}))`;
      const [{ hay }] = await tx.$queryRaw<{ hay: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM registros_auditoria
          WHERE accion = 'fraude.modelo' AND organizacion_id = ${organizacionId}::uuid
            AND creado_en > ${desde}) AS hay`;
      if (hay) return null;

      if (entrenamiento.length < MINIMO_PARES) {
        await this.auditoria.registrar(
          {
            accion: 'fraude.modelo',
            entidad: 'organizacion',
            entidadId: organizacionId,
            resultado: 'fallo',
            organizacionId,
            detalle: {
              motivo: 'sin_datos',
              pares: entrenamiento.length,
              minimo: MINIMO_PARES,
            },
          },
          tx,
        );
        return -1;
      }

      const filas = entrenamiento.map((p) => aFila(p.cifras));
      const modelo = entrenarModelo(filas, semilla);
      const evaluados = datos.pares.map((p) => ({
        ...p,
        ...evaluarPar(modelo, aFila(p.cifras)),
      }));
      const histograma = Array.from({ length: 10 }, () => 0);
      for (const e of evaluados)
        histograma[Math.min(9, Math.floor(e.puntaje / 10))]++;
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM registros_auditoria
        WHERE accion = 'fraude.modelo' AND organizacion_id = ${organizacionId}::uuid AND resultado = 'ok'`;
      const version = n + 1;
      await this.auditoria.registrar(
        {
          accion: 'fraude.modelo',
          entidad: 'organizacion',
          entidadId: organizacionId,
          resultado: 'ok',
          organizacionId,
          detalle: {
            version,
            semilla,
            pares: filas.length,
            filas,
            histograma,
            umbral: UMBRAL_ALERTA,
          },
        },
        tx,
      );
      this.cache.set(organizacionId, { version, modelo });

      let alertas = 0;
      const haceSiete = new Date(ahora.getTime() - SIN_REPETIR_MS);
      const repetida = async (patron: string, personas: string[]) => {
        const [{ existe }] = await tx.$queryRaw<{ existe: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM registros_auditoria
            WHERE accion = 'fraude.alerta' AND organizacion_id = ${organizacionId}::uuid
              AND detalle->>'patron' = ${patron}
              AND detalle->'personas' = ${JSON.stringify(personas)}::jsonb
              AND creado_en > ${haceSiete}) AS existe`;
        return existe;
      };
      for (const e of evaluados) {
        if (e.puntaje < UMBRAL_ALERTA) continue;
        if (await repetida('comportamiento_atipico', e.personas)) continue;
        await this.auditoria.registrar(
          {
            accion: 'fraude.alerta',
            entidad: 'organizacion',
            entidadId: organizacionId,
            resultado: 'ok',
            organizacionId,
            detalle: {
              patron: 'comportamiento_atipico',
              personas: e.personas,
              puntaje: e.puntaje,
              factores: e.factores,
              versionModelo: version,
              cantidad: e.cifras.viajes30d,
            },
          },
          tx,
        );
        alertas++;
      }
      for (const a of buscarAnillos(datos.aristas, datos.totales)) {
        if (await repetida('anillo_colusion', a.personas)) continue;
        await this.auditoria.registrar(
          {
            accion: 'fraude.alerta',
            entidad: 'organizacion',
            entidadId: organizacionId,
            resultado: 'ok',
            organizacionId,
            detalle: {
              patron: 'anillo_colusion',
              personas: a.personas,
              viajesInternos: a.viajesInternos,
              proporcion: a.proporcion,
              aristas: a.aristas,
              cantidad: a.viajesInternos,
            },
          },
          tx,
        );
        alertas++;
      }
      return alertas;
    });
  }

  /**
   * CA-5: puntaje del modelo vigente para las personas de una alerta. Par: ese par; una persona (P-3): su par más
   * frecuente; grupo (anillo): el mayor de sus pares. `null` sin modelo o sin pares (se usa el «estimado» de PB-10).
   */
  async puntajeDe(
    organizacionId: string,
    personas: string[],
    ahora: Date = new Date(),
  ): Promise<PuntajeModelo | null> {
    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const vigente = await this.modeloVigente(tx, organizacionId);
      if (!vigente) return null;
      const { pares } = await this.datosOrganizacion(tx, organizacionId, ahora);
      const dentro = new Set(personas);
      const candidatos =
        personas.length === 1
          ? pares
              .filter((p) => p.personas.includes(personas[0]))
              .sort((a, b) => b.cifras.viajes30d - a.cifras.viajes30d)
              .slice(0, 1)
          : pares.filter(
              (p) => dentro.has(p.personas[0]) && dentro.has(p.personas[1]),
            );
      let mejor: PuntajeModelo | null = null;
      for (const p of candidatos) {
        const e = evaluarPar(vigente.modelo, aFila(p.cifras));
        if (!mejor || e.puntaje > mejor.puntaje)
          mejor = {
            ...e,
            riesgo: riesgoDe(e.puntaje),
            version: vigente.version,
          };
      }
      return mejor;
    });
  }

  /** Último modelo `ok` de la organización; se reconstruye desde la auditoría con su semilla (RN-4). */
  private async modeloVigente(
    tx: Transaccion,
    organizacionId: string,
  ): Promise<{ version: number; modelo: Modelo } | null> {
    const [r] = await tx.$queryRaw<{ version: number }[]>`
      SELECT (detalle->>'version')::int AS version FROM registros_auditoria
      WHERE accion = 'fraude.modelo' AND organizacion_id = ${organizacionId}::uuid AND resultado = 'ok'
      ORDER BY creado_en DESC, id DESC LIMIT 1`;
    if (!r) return null;
    const enCache = this.cache.get(organizacionId);
    if (enCache?.version === r.version) return enCache;
    const [m] = await tx.$queryRaw<Pick<RegistroModelo, 'semilla' | 'filas'>[]>`
      SELECT (detalle->>'semilla')::bigint::float8 AS semilla, detalle->'filas' AS filas
      FROM registros_auditoria
      WHERE accion = 'fraude.modelo' AND organizacion_id = ${organizacionId}::uuid AND resultado = 'ok'
        AND (detalle->>'version')::int = ${r.version}
      LIMIT 1`;
    const vigente = {
      version: r.version,
      modelo: entrenarModelo(m.filas, Number(m.semilla)),
    };
    this.cache.set(organizacionId, vigente);
    return vigente;
  }

  /** Para el desempeño (CA-10): último modelo y último intento sin datos. */
  async estado(tx: Transaccion, organizacionId: string) {
    const [ok] = await tx.$queryRaw<
      Omit<RegistroModelo, 'filas' | 'semilla'>[]
    >`
      SELECT (detalle->>'version')::int AS version, (detalle->>'pares')::int AS pares,
        detalle->'histograma' AS histograma, creado_en
      FROM registros_auditoria
      WHERE accion = 'fraude.modelo' AND organizacion_id = ${organizacionId}::uuid AND resultado = 'ok'
      ORDER BY creado_en DESC, id DESC LIMIT 1`;
    const [sinDatos] = await tx.$queryRaw<
      { pares: number; minimo: number; creado_en: Date }[]
    >`
      SELECT (detalle->>'pares')::int AS pares, (detalle->>'minimo')::int AS minimo, creado_en
      FROM registros_auditoria
      WHERE accion = 'fraude.modelo' AND organizacion_id = ${organizacionId}::uuid AND resultado = 'fallo'
      ORDER BY creado_en DESC, id DESC LIMIT 1`;
    return { ok: ok ?? null, sinDatos: sinDatos ?? null };
  }

  /** Personas o pares cuya alerta tiene como última decisión «Fraude confirmado». */
  private async confirmados(
    tx: Transaccion,
    organizacionId: string,
  ): Promise<(par: [string, string]) => boolean> {
    const filas = await tx.$queryRaw<{ personas: string[] }[]>`
      SELECT a.detalle->'personas' AS personas FROM registros_auditoria a
      JOIN LATERAL (SELECT d.detalle->>'decision' AS decision FROM registros_auditoria d
        WHERE d.accion = 'fraude.decision' AND d.entidad_id = a.id::text
        ORDER BY d.creado_en DESC, d.id DESC LIMIT 1) d ON true
      WHERE a.accion = 'fraude.alerta' AND a.organizacion_id = ${organizacionId}::uuid
        AND d.decision = 'confirmado'`;
    const personas = new Set<string>();
    const grupos: Set<string>[] = [];
    for (const f of filas)
      if (f.personas.length === 1) personas.add(f.personas[0]);
      else grupos.push(new Set(f.personas));
    return ([a, b]) =>
      personas.has(a) ||
      personas.has(b) ||
      grupos.some((g) => g.has(a) && g.has(b));
  }

  /** RN-3: cifras de cada par con viajes pagados en 30 días, solo con datos de la organización (A-13). */
  async datosOrganizacion(
    tx: Transaccion,
    organizacionId: string,
    ahora: Date,
  ): Promise<DatosOrganizacion> {
    const hace7 = new Date(ahora.getTime() - 7 * DIA_MS);
    const hace30 = new Date(ahora.getTime() - 30 * DIA_MS);
    const viajes = await tx.$queryRaw<
      {
        conductor: string;
        pasajero: string;
        salida: Date;
        abordaje: Date | null;
        bajada: Date | null;
        alat: number | null;
        alng: number | null;
        blat: number | null;
        blng: number | null;
      }[]
    >`
      SELECT v.conductor_id AS conductor, r.pasajero_id AS pasajero, v.fecha_hora_salida AS salida,
        ab.creado_en AS abordaje, ba.creado_en AS bajada,
        ab.pasajero_lat AS alat, ab.pasajero_lng AS alng, ba.pasajero_lat AS blat, ba.pasajero_lng AS blng
      FROM reservas r JOIN viajes v ON v.id = r.viaje_id
      LEFT JOIN pruebas_presencia ab ON ab.reserva_id = r.id AND ab.tipo = 'abordaje' AND ab.resultado = 'aceptada'
      LEFT JOIN pruebas_presencia ba ON ba.reserva_id = r.id AND ba.tipo = 'bajada' AND ba.resultado = 'aceptada'
      WHERE r.organizacion_id = ${organizacionId}::uuid AND r.estado = 'pagada'
        AND v.fecha_hora_salida > ${hace30} AND v.fecha_hora_salida <= ${ahora}`;

    const totales = new Map<string, number>();
    const porPar = new Map<
      string,
      {
        personas: [string, string];
        v7: number;
        v30: number;
        comoConductor: Map<string, number>;
        distancias: number[];
        duraciones: number[];
      }
    >();
    for (const v of viajes) {
      for (const p of [v.conductor, v.pasajero])
        totales.set(p, (totales.get(p) ?? 0) + 1);
      const clave = clavePar(v.conductor, v.pasajero);
      let par = porPar.get(clave);
      if (!par) {
        par = {
          personas: ordenarPar(v.conductor, v.pasajero),
          v7: 0,
          v30: 0,
          comoConductor: new Map(),
          distancias: [],
          duraciones: [],
        };
        porPar.set(clave, par);
      }
      par.v30++;
      if (v.salida > hace7) par.v7++;
      par.comoConductor.set(
        v.conductor,
        (par.comoConductor.get(v.conductor) ?? 0) + 1,
      );
      if (v.abordaje && v.bajada)
        par.duraciones.push(
          (v.bajada.getTime() - v.abordaje.getTime()) / 60_000,
        );
      if (v.alat != null && v.alng != null && v.blat != null && v.blng != null)
        // Las coordenadas se usan solo aquí; al modelo llegan promedios (HU-25 RN-10).
        par.distancias.push(
          distanciaM(
            { lat: Number(v.alat), lng: Number(v.alng) },
            { lat: Number(v.blat), lng: Number(v.blng) },
          ),
        );
    }
    if (!porPar.size) return { pares: [], aristas: [], totales };

    const ids = [...totales.keys()];
    const calificaciones = await tx.$queryRaw<
      { autor: string; destinatario: string; n: number }[]
    >`
      SELECT autor_id AS autor, destinatario_id AS destinatario, count(*)::int AS n FROM calificaciones
      WHERE organizacion_id = ${organizacionId}::uuid AND creado_en > ${hace30}
        AND destinatario_id = ANY(${ids}::uuid[])
      GROUP BY autor_id, destinatario_id`;
    const usuarios = await tx.$queryRaw<{ id: string; dias: number }[]>`
      SELECT id, floor(extract(epoch FROM (${ahora}::timestamptz - creado_en)) / 86400)::int AS dias
      FROM usuarios WHERE id = ANY(${ids}::uuid[])`;
    const dinero = await tx.$queryRaw<
      { usuario: string; recargas: number; cobros: number; pagos: number }[]
    >`
      SELECT b.usuario_id AS usuario,
        count(*) FILTER (WHERE m.tipo = 'recarga')::int AS recargas,
        count(*) FILTER (WHERE m.tipo = 'liberacion_viaje')::int AS cobros,
        count(*) FILTER (WHERE m.tipo = 'bloqueo_reserva')::int AS pagos
      FROM movimientos_billetera m JOIN billeteras b ON b.id = m.billetera_id
      WHERE b.usuario_id = ANY(${ids}::uuid[]) AND m.creado_en > ${hace30}
      GROUP BY b.usuario_id`;
    const fallidas = await tx.$queryRaw<{ a: string; b: string; n: number }[]>`
      SELECT v.conductor_id AS a, r.pasajero_id AS b, count(*)::int AS n
      FROM reservas r JOIN viajes v ON v.id = r.viaje_id
      WHERE r.organizacion_id = ${organizacionId}::uuid AND r.estado = 'verificacion_fallida'
        AND r.actualizado_en > ${hace7}
      GROUP BY v.conductor_id, r.pasajero_id`;

    const recibidas = new Map<string, number>();
    const delOtro = new Map<string, number>();
    for (const c of calificaciones) {
      recibidas.set(c.destinatario, (recibidas.get(c.destinatario) ?? 0) + c.n);
      delOtro.set(`${c.autor}>${c.destinatario}`, c.n);
    }
    const antiguedad = new Map(usuarios.map((u) => [u.id, u.dias]));
    // Dinero que circula: cobra y paga viajes sin haber recargado (los viajes no crean saldo, AGENTS.md §5.5).
    const circular = new Map(
      dinero.map((d) => [
        d.usuario,
        d.recargas === 0 ? Math.min(d.cobros, d.pagos) : 0,
      ]),
    );
    const fallidasPar = new Map<string, number>();
    for (const f of fallidas) {
      const k = clavePar(f.a, f.b);
      fallidasPar.set(k, (fallidasPar.get(k) ?? 0) + f.n);
    }
    const promedio = (l: number[]) =>
      l.length ? l.reduce((s, x) => s + x, 0) / l.length : null;

    // Sin posición o sin hora de bajada, el promedio de la organización: no castiga ni premia la falta de dato.
    const todasDist = [...porPar.values()].flatMap((p) => p.distancias);
    const todasDur = [...porPar.values()].flatMap((p) => p.duraciones);
    const distOrg = promedio(todasDist) ?? 5000;
    const durOrg = promedio(todasDur) ?? 15;

    const pares: ParOrganizacion[] = [];
    const aristas: Arista[] = [];
    for (const [clave, p] of porPar) {
      const [a, b] = p.personas;
      const conductor =
        (p.comoConductor.get(a) ?? 0) >= (p.comoConductor.get(b) ?? 0) ? a : b;
      const pasajero = conductor === a ? b : a;
      const fraccionCalif = (de: string, para: string) => {
        const total = recibidas.get(para) ?? 0;
        return total ? (delOtro.get(`${de}>${para}`) ?? 0) / total : 0;
      };
      pares.push({
        personas: p.personas,
        cifras: {
          viajes7d: p.v7,
          viajes30d: p.v30,
          distanciaPromedioM: Math.round(promedio(p.distancias) ?? distOrg),
          duracionPromedioMin: redondear(promedio(p.duraciones) ?? durOrg, 1),
          fraccionConductor: redondear(
            p.v30 / (totales.get(conductor) ?? p.v30),
            2,
          ),
          fraccionPasajero: redondear(
            p.v30 / (totales.get(pasajero) ?? p.v30),
            2,
          ),
          fraccionCalificacionesDelPar: redondear(
            Math.max(fraccionCalif(a, b), fraccionCalif(b, a)),
            2,
          ),
          antiguedadMinimaDias: Math.min(
            antiguedad.get(a) ?? 0,
            antiguedad.get(b) ?? 0,
          ),
          cobrosSinRecarga: Math.max(
            circular.get(a) ?? 0,
            circular.get(b) ?? 0,
          ),
          fallidas7d: fallidasPar.get(clave) ?? 0,
        },
      });
      aristas.push({ a, b, viajes: p.v30 });
    }
    pares.sort((x, y) =>
      clavePar(...x.personas).localeCompare(clavePar(...y.personas)),
    );
    return { pares, aristas, totales };
  }
}
