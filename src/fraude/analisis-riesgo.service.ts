import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { IaServicio } from '../ia/ia.servicio.js';
import { distanciaM } from '../presencia/geo.js';
import {
  ALERTAS_POR_CICLO,
  INTENTOS_MAXIMOS,
  numerosDe,
  PROMPT_SISTEMA,
  PROMPT_SISTEMA_MODELO,
  textoPerfil,
  validarAnalisis,
  type CifrasPar,
  type CifrasPersona,
  type Perfil,
} from './analisis-riesgo.js';
import { ModeloRiesgoService } from './modelo-riesgo.service.js';
import { DIA_MS, ordenarPar } from './patrones.js';

interface AlertaPendiente {
  id: string;
  organizacion_id: string;
  creado_en: Date;
  detalle: {
    patron: string;
    personas: string[];
    reservaId?: string;
    cantidad?: number;
    distanciaM?: number;
    minutos?: number;
    viajesInternos?: number;
    proporcion?: number;
  };
}

export interface ResumenAnalisis {
  analizadas: number;
  fallidas: number;
}

/**
 * PB-10: analiza con IA cada alerta de HU-25 (IA local → Groq). Solo escribe registros `fraude.analisis_ia` en la
 * auditoría: nunca crea ni levanta bloqueos, ni toca reservas, viajes o saldos (RN-1, CA-7).
 */
@Injectable()
export class AnalisisRiesgoService implements OnModuleInit, OnModuleDestroy {
  private readonly registro = new Logger(AnalisisRiesgoService.name);
  private temporizador?: NodeJS.Timeout;
  private ocupado = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly ia: IaServicio,
    private readonly modeloRiesgo: ModeloRiesgoService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const ms = Number(process.env.IA_ANALISIS_INTERVALO_MS) || 60_000;
    this.temporizador = setInterval(() => void this.tic(), ms);
  }

  onModuleDestroy(): void {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  private async tic(): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      await this.analizarPendientes();
    } catch (error) {
      this.registro.error('Error en el tic de análisis de riesgo', error);
    } finally {
      this.ocupado = false;
    }
  }

  /** Las pruebas lo invocan a mano y lo limitan a su organización para no tocar otras alertas de la base. */
  async analizarPendientes(
    soloOrganizacion: string | null = null,
  ): Promise<ResumenAnalisis> {
    const ahora = new Date();
    const resumen: ResumenAnalisis = { analizadas: 0, fallidas: 0 };
    const pendientes = await this.prisma.comoSuperAdmin(
      (tx) => tx.$queryRaw<AlertaPendiente[]>`
        SELECT a.id, a.organizacion_id, a.creado_en, a.detalle FROM registros_auditoria a
        WHERE a.accion = 'fraude.alerta' AND a.organizacion_id IS NOT NULL
          AND (${soloOrganizacion}::uuid IS NULL OR a.organizacion_id = ${soloOrganizacion}::uuid)
          AND NOT EXISTS (SELECT 1 FROM registros_auditoria x
            WHERE x.accion = 'fraude.analisis_ia' AND x.entidad_id = a.id::text AND x.resultado = 'ok')
          AND (SELECT count(*) FROM registros_auditoria x
            WHERE x.accion = 'fraude.analisis_ia' AND x.entidad_id = a.id::text AND x.resultado = 'fallo') < ${INTENTOS_MAXIMOS}
        ORDER BY a.creado_en, a.id
        LIMIT ${ALERTAS_POR_CICLO}`,
    );
    for (const alerta of pendientes) {
      try {
        if (await this.analizar(alerta, ahora)) resumen.analizadas++;
        else resumen.fallidas++;
      } catch (error) {
        resumen.fallidas++;
        this.registro.error(
          `Análisis de riesgo: falló la alerta ${alerta.id}: ${(error as Error).name}`,
        );
      }
    }
    return resumen;
  }

  private async analizar(a: AlertaPendiente, ahora: Date): Promise<boolean> {
    const perfil = await this.prisma.enOrganizacion(a.organizacion_id, (tx) =>
      this.perfil(tx, a, ahora),
    );
    // PB-11 CA-5: con modelo propio vigente, el puntaje y el riesgo salen de él.
    const propio = await this.modeloRiesgo.puntajeDe(
      a.organizacion_id,
      a.detalle.personas,
      ahora,
    );
    if (propio)
      perfil.modelo = {
        puntaje: propio.puntaje,
        riesgo: propio.riesgo,
        factores: propio.factores,
        percentiles: propio.percentiles,
      };
    const texto = textoPerfil(perfil);
    // La IA se llama fuera de la transacción: puede tardar hasta 30 s.
    const respuesta = await this.ia.completarJson(
      propio ? PROMPT_SISTEMA_MODELO : PROMPT_SISTEMA,
      texto,
    );
    const analisis = respuesta
      ? validarAnalisis(
          respuesta.json,
          propio ? { ...propio, numeros: numerosDe(texto) } : undefined,
        )
      : null;
    const detalle = analisis
      ? {
          ...analisis,
          proveedor: respuesta!.proveedor,
          modelo: respuesta!.modelo,
          origenPuntaje: propio ? 'modelo' : 'estimado',
          ...(propio && {
            factores: propio.factores,
            versionModelo: propio.version,
          }),
        }
      : { motivo: respuesta ? 'formato_invalido' : 'sin_proveedor' };

    // CA-11: un solo análisis por alerta aunque dos procesos lleguen a la vez.
    await this.prisma.enOrganizacion(a.organizacion_id, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${a.id}))`;
      const [{ hay }] = await tx.$queryRaw<{ hay: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM registros_auditoria
          WHERE accion = 'fraude.analisis_ia' AND entidad_id = ${a.id} AND resultado = 'ok') AS hay`;
      if (hay) return;
      await this.auditoria.registrar(
        {
          accion: 'fraude.analisis_ia',
          entidad: 'registro_auditoria',
          entidadId: a.id,
          resultado: analisis ? 'ok' : 'fallo',
          organizacionId: a.organizacion_id,
          detalle,
        },
        tx,
      );
    });
    return Boolean(analisis);
  }

  /** RN-4: solo cifras, calculadas con RLS de la organización de la alerta (A-13). */
  private async perfil(
    tx: Transaccion,
    a: AlertaPendiente,
    ahora: Date,
  ): Promise<Perfil> {
    const d = a.detalle;
    const hace7 = new Date(ahora.getTime() - 7 * DIA_MS);
    const hace30 = new Date(ahora.getTime() - 30 * DIA_MS);
    const [x, y] = d.personas;
    const esPar = d.personas.length === 2;
    const personasJson = JSON.stringify(
      esPar ? ordenarPar(x, y) : [...d.personas].sort(),
    );

    const [{ n: alertasPrevias }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM registros_auditoria
      WHERE accion = 'fraude.alerta' AND detalle->'personas' = ${personasJson}::jsonb
        AND creado_en < ${a.creado_en} AND id <> ${a.id}::uuid`;

    let par: CifrasPar | null = null;
    if (esPar) {
      const reservas = await tx.$queryRaw<
        {
          salida: Date;
          abordaje: Date | null;
          bajada: Date | null;
          alat: number | null;
          alng: number | null;
          blat: number | null;
          blng: number | null;
        }[]
      >`
        SELECT v.fecha_hora_salida AS salida,
          ab.creado_en AS abordaje, ba.creado_en AS bajada,
          ab.pasajero_lat AS alat, ab.pasajero_lng AS alng, ba.pasajero_lat AS blat, ba.pasajero_lng AS blng
        FROM reservas r JOIN viajes v ON v.id = r.viaje_id
        LEFT JOIN pruebas_presencia ab ON ab.reserva_id = r.id AND ab.tipo = 'abordaje' AND ab.resultado = 'aceptada'
        LEFT JOIN pruebas_presencia ba ON ba.reserva_id = r.id AND ba.tipo = 'bajada' AND ba.resultado = 'aceptada'
        WHERE r.estado = 'pagada' AND v.fecha_hora_salida > ${hace30}
          AND ((v.conductor_id = ${x}::uuid AND r.pasajero_id = ${y}::uuid)
            OR (v.conductor_id = ${y}::uuid AND r.pasajero_id = ${x}::uuid))`;
      const distancias: number[] = [];
      const duraciones: number[] = [];
      for (const r of reservas) {
        if (r.abordaje && r.bajada)
          duraciones.push((r.bajada.getTime() - r.abordaje.getTime()) / 60_000);
        if (
          r.alat != null &&
          r.alng != null &&
          r.blat != null &&
          r.blng != null
        )
          distancias.push(
            distanciaM(
              { lat: r.alat, lng: r.alng },
              { lat: r.blat, lng: r.blng },
            ),
          );
      }
      // Las coordenadas se usan solo aquí; al perfil llegan promedios (HU-25 RN-10).
      par = {
        reservas7d: reservas.filter((r) => r.salida > hace7).length,
        reservas30d: reservas.length,
        distanciaPromedioM: promedio(distancias, 0),
        duracionPromedioMin: promedio(duraciones, 1),
      };
    }

    const personas: CifrasPersona[] = [];
    for (const id of d.personas) {
      const otro = esPar ? (d.personas.find((p) => p !== id) ?? null) : null;
      const [c] = await tx.$queryRaw<
        {
          antiguedad_dias: number;
          fallidas7d: number;
          calif_promedio: number | null;
          calificaciones: number;
          calif_del_par: number;
          recargas30d: number;
          cobros30d: number;
          pagos30d: number;
        }[]
      >`
        SELECT
          COALESCE(floor(extract(epoch FROM (${ahora}::timestamptz - u.creado_en)) / 86400), 0)::int AS antiguedad_dias,
          (SELECT count(*)::int FROM reservas r JOIN viajes v ON v.id = r.viaje_id
            WHERE r.estado = 'verificacion_fallida' AND r.actualizado_en > ${hace7}
              AND (r.pasajero_id = u.id OR v.conductor_id = u.id)) AS fallidas7d,
          (SELECT round(avg(estrellas)::numeric, 2)::float FROM calificaciones WHERE destinatario_id = u.id) AS calif_promedio,
          (SELECT count(*)::int FROM calificaciones WHERE destinatario_id = u.id) AS calificaciones,
          (SELECT count(*)::int FROM calificaciones WHERE destinatario_id = u.id AND autor_id = ${otro}::uuid) AS calif_del_par,
          (SELECT count(*)::int FROM movimientos_billetera m JOIN billeteras b ON b.id = m.billetera_id
            WHERE b.usuario_id = u.id AND m.tipo = 'recarga' AND m.creado_en > ${hace30}) AS recargas30d,
          (SELECT count(*)::int FROM movimientos_billetera m JOIN billeteras b ON b.id = m.billetera_id
            JOIN reservas r ON r.id = m.reserva_id
            WHERE b.usuario_id = u.id AND m.tipo = 'liberacion_viaje' AND m.creado_en > ${hace30}) AS cobros30d,
          (SELECT count(*)::int FROM movimientos_billetera m JOIN billeteras b ON b.id = m.billetera_id
            JOIN reservas r ON r.id = m.reserva_id
            WHERE b.usuario_id = u.id AND m.tipo = 'bloqueo_reserva' AND m.creado_en > ${hace30}) AS pagos30d
        FROM usuarios u WHERE u.id = ${id}::uuid`;
      personas.push({
        antiguedadDias: c?.antiguedad_dias ?? 0,
        fallidas7d: c?.fallidas7d ?? 0,
        calificacionPromedio: c?.calif_promedio ?? null,
        calificaciones: c?.calificaciones ?? 0,
        calificacionesDelPar: c?.calif_del_par ?? 0,
        recargas30d: c?.recargas30d ?? 0,
        cobros30d: c?.cobros30d ?? 0,
        pagos30d: c?.pagos30d ?? 0,
      });
    }

    return {
      patron: d.patron,
      ...(d.patron === 'anillo_colusion' && {
        anillo: {
          personas: d.personas.length,
          viajesInternos: d.viajesInternos ?? 0,
          proporcion: d.proporcion ?? 0,
        },
      }),
      cantidad: d.cantidad,
      distanciaM: d.distanciaM,
      minutos: d.minutos,
      alertasPrevias,
      par,
      personas,
    };
  }
}

function promedio(valores: number[], decimales: number): number | null {
  if (!valores.length) return null;
  const f = 10 ** decimales;
  return (
    Math.round((valores.reduce((s, v) => s + v, 0) / valores.length) * f) / f
  );
}
