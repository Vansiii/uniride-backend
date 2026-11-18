import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { BlockchainService } from '../blockchain/blockchain.service.js';
import type { PrismaService } from '../comun/prisma.service.js';
import type { DispositivosService } from '../dispositivos/dispositivos.service.js';
import type { ViajesService } from '../viajes/viajes.service.js';
import { PresenciaService } from './presencia.service.js';

describe('PresenciaService.distanciaConductor (HU-28)', () => {
  const AHORA = new Date('2026-11-17T12:00:00.000Z');
  // Punto de origen: -17.780000, -63.180000
  const ORIGEN = { lat: -17.78, lng: -63.18 };

  function crearServicio(opciones: {
    reserva?: Record<string, unknown> | null;
    desafio?: Record<string, unknown> | null;
    puntoGps?: Record<string, unknown> | null;
  }) {
    const tx = {
      reserva: {
        findFirst: vi.fn().mockResolvedValue(
          opciones.reserva !== undefined
            ? opciones.reserva
            : {
                id: 'reserva-1',
                estado: 'confirmada',
                viaje: {
                  id: 'viaje-1',
                  conductorId: 'conductor-1',
                  origenLat: new Prisma.Decimal(ORIGEN.lat),
                  origenLng: new Prisma.Decimal(ORIGEN.lng),
                },
              },
        ),
      },
      desafioHandshake: {
        findFirst: vi.fn().mockResolvedValue(opciones.desafio ?? null),
      },
      puntoGps: {
        findFirst: vi.fn().mockResolvedValue(opciones.puntoGps ?? null),
      },
    };

    const prisma = {
      enOrganizacion: vi.fn((_orgId: string, fn: (t: typeof tx) => unknown) =>
        fn(tx),
      ),
    } as unknown as PrismaService;

    const dispositivos = {} as DispositivosService;
    const auditoria = {} as AuditoriaService;
    const viajes = {} as ViajesService;
    const blockchain = {} as BlockchainService;

    return new PresenciaService(
      prisma,
      dispositivos,
      auditoria,
      viajes,
      blockchain,
    );
  }

  it('lanza 404 RESERVA_NO_ENCONTRADA si la reserva no existe', async () => {
    const servicio = crearServicio({ reserva: null });
    await expect(
      servicio.distanciaConductor(
        'pasajero-1',
        'org-1',
        'reserva-inexistente',
        AHORA,
      ),
    ).rejects.toMatchObject({
      codigo: 'RESERVA_NO_ENCONTRADA',
      status: 404,
    });
  });

  it('lanza 404 RESERVA_NO_ENCONTRADA si la reserva no está confirmada', async () => {
    const servicio = crearServicio({
      reserva: {
        id: 'reserva-1',
        estado: 'pendiente',
        viaje: {
          id: 'viaje-1',
          conductorId: 'conductor-1',
          origenLat: new Prisma.Decimal(ORIGEN.lat),
          origenLng: new Prisma.Decimal(ORIGEN.lng),
        },
      },
    });
    await expect(
      servicio.distanciaConductor('pasajero-1', 'org-1', 'reserva-1', AHORA),
    ).rejects.toMatchObject({
      codigo: 'RESERVA_NO_ENCONTRADA',
      status: 404,
    });
  });

  it('devuelve disponible: false si el conductor no tiene ninguna posición registrada', async () => {
    const servicio = crearServicio({ desafio: null, puntoGps: null });
    const r = await servicio.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(r).toEqual({
      disponible: false,
      distanciaM: null,
      enPuntoDeEncuentro: false,
      haceSegundos: null,
    });
  });

  it('usa la posición del desafío si es la única disponible y tiene ≤ 60 s', async () => {
    // 0,0027° de latitud ≈ 300 m
    const desafioLat = ORIGEN.lat + 0.0027;
    const tomadaEn = new Date(AHORA.getTime() - 25_000); // hace 25 s
    const servicio = crearServicio({
      desafio: {
        conductorLat: desafioLat,
        conductorLng: ORIGEN.lng,
        conductorTomadaEn: tomadaEn,
      },
      puntoGps: null,
    });

    const r = await servicio.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(r.disponible).toBe(true);
    expect(r.haceSegundos).toBe(25);
    expect(r.distanciaM).toBe(300);
    expect(r.enPuntoDeEncuentro).toBe(false);
  });

  it('usa la posición del punto GPS si es más reciente que el desafío', async () => {
    const desafioTomadaEn = new Date(AHORA.getTime() - 40_000);
    const gpsTomadaEn = new Date(AHORA.getTime() - 10_000); // más reciente
    const servicio = crearServicio({
      desafio: {
        conductorLat: ORIGEN.lat + 0.01,
        conductorLng: ORIGEN.lng,
        conductorTomadaEn: desafioTomadaEn,
      },
      puntoGps: {
        lat: ORIGEN.lat + 0.0009, // ~100 m
        lng: ORIGEN.lng,
        tomadaEn: gpsTomadaEn,
      },
    });

    const r = await servicio.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(r.disponible).toBe(true);
    expect(r.haceSegundos).toBe(10);
    expect(r.distanciaM).toBe(100);
  });

  it('límite de tiempo: hace 60 s es disponible, hace 61 s no', async () => {
    const s60 = crearServicio({
      puntoGps: {
        lat: ORIGEN.lat,
        lng: ORIGEN.lng,
        tomadaEn: new Date(AHORA.getTime() - 60_000),
      },
    });
    const r60 = await s60.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(r60.disponible).toBe(true);
    expect(r60.haceSegundos).toBe(60);

    const s61 = crearServicio({
      puntoGps: {
        lat: ORIGEN.lat,
        lng: ORIGEN.lng,
        tomadaEn: new Date(AHORA.getTime() - 61_000),
      },
    });
    const r61 = await s61.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(r61.disponible).toBe(false);
    expect(r61.distanciaM).toBeNull();
    expect(r61.haceSegundos).toBeNull();
  });

  it('límite de distancia: a ≤ 50 m marca enPuntoDeEncuentro: true, a 51 m marca false', async () => {
    // 0,000449° de latitud ≈ 49,93 m (≤ 50 m)
    const sCerca = crearServicio({
      puntoGps: {
        lat: ORIGEN.lat + 0.000449,
        lng: ORIGEN.lng,
        tomadaEn: new Date(AHORA.getTime() - 15_000),
      },
    });
    const rCerca = await sCerca.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(rCerca.disponible).toBe(true);
    expect(rCerca.distanciaM).toBe(50);
    expect(rCerca.enPuntoDeEncuentro).toBe(true);

    // 0,000459° de latitud ≈ 51,04 m (> 50 m)
    const sLejos = crearServicio({
      puntoGps: {
        lat: ORIGEN.lat + 0.000459,
        lng: ORIGEN.lng,
        tomadaEn: new Date(AHORA.getTime() - 15_000),
      },
    });
    const rLejos = await sLejos.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(rLejos.disponible).toBe(true);
    expect(rLejos.distanciaM).toBe(50); // redondeado a decenas da 50
    expect(rLejos.enPuntoDeEncuentro).toBe(false); // exacta > 50 m
  });

  it('redondea la distancia a decenas de metros (ej: ~296 m -> 300 m)', async () => {
    // 0,00266° ≈ 295,8 m -> redondea a 300
    const sRedondeo = crearServicio({
      puntoGps: {
        lat: ORIGEN.lat + 0.00266,
        lng: ORIGEN.lng,
        tomadaEn: new Date(AHORA.getTime() - 10_000),
      },
    });
    const r = await sRedondeo.distanciaConductor(
      'pasajero-1',
      'org-1',
      'reserva-1',
      AHORA,
    );
    expect(r.disponible).toBe(true);
    expect(r.distanciaM).toBe(300);
  });
});
