import { describe, expect, it, vi } from 'vitest';
import { AsistenteService } from '../asistente.service.js';
import type { GroqServicio } from '../groq.servicio.js';

describe('AsistenteService', () => {
  it('usa respuesta estructurada de Groq si es válida y la ruta está permitida', async () => {
    const mockGroq: Partial<GroqServicio> = {
      completarJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          modo: 'accion',
          mensaje: 'Te llevo a buscar viajes para mañana.',
          accion: {
            ruta: '/buscar',
            params: { destino: 'UAGRM' },
            etiquetaBoton: 'Buscar viaje',
          },
        }),
      ),
    };

    const servicio = new AsistenteService(mockGroq as GroqServicio);
    const resultado = await servicio.consultar(
      'quiero ir a la UAGRM',
      'movil',
    );

    expect(resultado.modo).toBe('accion');
    expect(resultado.mensaje).toBe('Te llevo a buscar viajes para mañana.');
    expect(resultado.accion?.ruta).toBe('/buscar');
    expect(resultado.accion?.params).toEqual({ destino: 'UAGRM' });
  });

  it('descarta rutas no permitidas que el LLM intente inventar', async () => {
    const mockGroq: Partial<GroqServicio> = {
      completarJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          modo: 'accion',
          mensaje: 'Ruta no permitida.',
          accion: {
            ruta: '/ruta/maliciosa/o/inexistente',
            etiquetaBoton: 'Peligro',
          },
        }),
      ),
    };

    const servicio = new AsistenteService(mockGroq as GroqServicio);
    const resultado = await servicio.consultar('consulta rara', 'movil');

    expect(resultado.modo).toBe('accion');
    expect(resultado.accion).toBeUndefined();
  });

  it('activa fallback local para saldo si Groq falla o no está disponible', async () => {
    const mockGroq: Partial<GroqServicio> = {
      completarJson: vi.fn().mockResolvedValue(null),
    };

    const servicio = new AsistenteService(mockGroq as GroqServicio);
    const resultado = await servicio.consultar('cuál es mi saldo?', 'movil');

    expect(resultado.modo).toBe('accion');
    expect(resultado.accion?.ruta).toBe('/billetera');
    expect(resultado.accion?.etiquetaBoton).toBe('Ver mi saldo');
  });

  it('activa fallback local para explicación de escrow/pago si Groq falla', async () => {
    const mockGroq: Partial<GroqServicio> = {
      completarJson: vi.fn().mockResolvedValue(null),
    };

    const servicio = new AsistenteService(mockGroq as GroqServicio);
    const resultado = await servicio.consultar('cómo funciona el pago en garantía?', 'movil');

    expect(resultado.modo).toBe('guia');
    expect(resultado.pasos).toBeDefined();
    expect(resultado.pasos?.length).toBeGreaterThanOrEqual(2);
    expect(resultado.mensaje).toContain('garantía');
  });

  it('devuelve fallback general ante consulta vacía o no coincidente', async () => {
    const mockGroq: Partial<GroqServicio> = {
      completarJson: vi.fn().mockResolvedValue(null),
    };

    const servicio = new AsistenteService(mockGroq as GroqServicio);
    const resultado = await servicio.consultar('   ', 'movil');

    expect(resultado.modo).toBe('guia');
    expect(resultado.mensaje).toContain('Soy tu Asistente UniRide');
    expect(resultado.pasos).toBeDefined();
  });
});

