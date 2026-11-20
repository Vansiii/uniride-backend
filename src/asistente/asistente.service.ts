import { Injectable, Logger } from '@nestjs/common';
import { GroqServicio } from './groq.servicio.js';
import type {
  AccionAsistenteDto,
  RespuestaAsistenteDto,
} from './dto/respuesta-asistente.dto.js';

const RUTAS_PERMITIDAS_MOVIL = new Set([
  '/buscar',
  '/mis-viajes',
  '/billetera',
  '/publicar',
  '/perfil',
]);

const RUTAS_PERMITIDAS_WEB = new Set([
  '/',
  '/organizaciones',
  '/perfil',
]);

@Injectable()
export class AsistenteService {
  private readonly logger = new Logger(AsistenteService.name);

  constructor(private readonly groqServicio: GroqServicio) {}

  /**
   * Procesa la consulta del usuario, interpretando acción directa o guía con pasos.
   * Utiliza Groq con validación estricta y degrada a fallback local ante cualquier falla.
   */
  async consultar(
    consulta: string,
    cliente: 'movil' | 'web' = 'movil',
  ): Promise<RespuestaAsistenteDto> {
    const textoLimpio = consulta.trim();
    if (!textoLimpio) {
      return this.obtenerFallbackGeneral(cliente);
    }

    const systemPrompt = this.construirSystemPrompt(cliente);
    const jsonRespuesta = await this.groqServicio.completarJson(
      systemPrompt,
      textoLimpio,
    );

    if (jsonRespuesta) {
      try {
        const parseado = JSON.parse(jsonRespuesta);
        const sanitizado = this.sanitizarRespuesta(parseado, cliente);
        if (sanitizado) {
          return sanitizado;
        }
      } catch (e) {
        this.logger.warn(`Error al parsear respuesta JSON de Groq: ${e}`);
      }
    }

    return this.procesarFallbackLocal(textoLimpio, cliente);
  }

  private construirSystemPrompt(cliente: 'movil' | 'web'): string {
    const rutasPermitidas =
      cliente === 'movil'
        ? Array.from(RUTAS_PERMITIDAS_MOVIL).join(', ')
        : Array.from(RUTAS_PERMITIDAS_WEB).join(', ');

    return `Eres el Asistente oficial de UniRide, la plataforma de carpooling universitario e institucional seguro.
Tu misión es guiar al usuario y ofrecer atajos directos sin rodeos ni charlas largas.
Respuestas concisas, en español neutro (máximo 2 oraciones en "mensaje").
REGLAS OBLIGATORIAS:
1. Responde ÚNICAMENTE en formato JSON con la siguiente estructura:
{
  "modo": "accion" | "guia",
  "mensaje": "Breve explicación de 1 o 2 oraciones",
  "accion": {
    "ruta": "Una ruta válida",
    "params": { "opcional": "valor" },
    "etiquetaBoton": "Texto del botón de acción"
  },
  "pasos": ["Paso 1 breve", "Paso 2 breve", "Paso 3 breve"]
}
2. RUTAS PERMITIDAS PARA ESTE CLIENTE (${cliente}): ${rutasPermitidas}. NO uses ninguna otra ruta.
3. Si el usuario pide buscar un viaje o consultar saldo, usa modo "accion" con la ruta respectiva y etiquetaBoton clara.
4. Si el usuario pide reservar o cancelar, la ruta debe ser la de confirmación oficial; NUNCA confirmes reservas o pagos tú mismo.
5. Si el usuario pregunta cómo funciona el pago, el abordaje o la app, usa modo "guia", incluye 2 a 3 "pasos" concisos y pon una "accion" con el botón para ir a esa sección.
6. Si la pregunta no tiene relación con UniRide, responde amablemente en modo "guia" diciendo que solo puedes ayudar con carpooling y funciones de UniRide, sin "accion" ni "pasos".`;
  }

  private sanitizarRespuesta(
    datos: any,
    cliente: 'movil' | 'web',
  ): RespuestaAsistenteDto | null {
    if (!datos || typeof datos !== 'object') return null;

    const modo = datos.modo === 'accion' ? 'accion' : 'guia';
    const mensaje =
      typeof datos.mensaje === 'string' && datos.mensaje.trim()
        ? datos.mensaje.trim()
        : 'Aquí tienes la información solicitada.';

    let accion: AccionAsistenteDto | undefined = undefined;
    if (datos.accion && typeof datos.accion.ruta === 'string') {
      const rutasPermitidas =
        cliente === 'movil' ? RUTAS_PERMITIDAS_MOVIL : RUTAS_PERMITIDAS_WEB;
      if (rutasPermitidas.has(datos.accion.ruta)) {
        accion = {
          ruta: datos.accion.ruta,
          params:
            typeof datos.accion.params === 'object' && datos.accion.params !== null
              ? datos.accion.params
              : undefined,
          etiquetaBoton:
            typeof datos.accion.etiquetaBoton === 'string' &&
            datos.accion.etiquetaBoton.trim()
              ? datos.accion.etiquetaBoton.trim()
              : 'Ir ahí',
        };
      }
    }

    const pasos =
      Array.isArray(datos.pasos) && datos.pasos.every((p: any) => typeof p === 'string')
        ? datos.pasos.slice(0, 4)
        : undefined;

    return {
      modo,
      mensaje,
      accion,
      pasos,
    };
  }

  procesarFallbackLocal(
    consulta: string,
    cliente: 'movil' | 'web',
  ): RespuestaAsistenteDto {
    const texto = consulta.toLowerCase();

    // Saldo / Billetera
    if (
      texto.includes('saldo') ||
      texto.includes('billetera') ||
      texto.includes('plata') ||
      texto.includes('urc')
    ) {
      if (cliente === 'movil') {
        return {
          modo: 'accion',
          mensaje: 'Puedes consultar tu saldo disponible y en garantía en tu Billetera.',
          accion: {
            ruta: '/billetera',
            etiquetaBoton: 'Ver mi saldo',
          },
        };
      }
      return {
        modo: 'guia',
        mensaje: 'La billetera y el saldo se gestionan desde la app móvil de UniRide vinculada a tu dispositivo.',
        pasos: [
          'Abre la app móvil en tu teléfono',
          'Ingresa a la pestaña Billetera',
          'Consulta tu saldo o recarga URC',
        ],
      };
    }

    // Buscar viajes
    if (
      texto.includes('buscar') ||
      texto.includes('viaje') ||
      texto.includes('llevame') ||
      texto.includes('destino') ||
      texto.includes('uagrm')
    ) {
      if (cliente === 'movil') {
        return {
          modo: 'accion',
          mensaje: 'Te llevo a la sección de búsqueda para encontrar viajes programados.',
          accion: {
            ruta: '/buscar',
            etiquetaBoton: 'Buscar viajes',
          },
        };
      }
      return {
        modo: 'guia',
        mensaje: 'La búsqueda y reserva de viajes se realiza desde la app móvil de UniRide.',
        pasos: [
          'Abre la app UniRide en tu celular',
          'Indica tu destino y horario',
          'Reserva tu asiento con garantía protegida',
        ],
      };
    }

    // Publicar viaje
    if (texto.includes('publicar') || texto.includes('conductor')) {
      if (cliente === 'movil') {
        return {
          modo: 'accion',
          mensaje: 'Para publicar viajes necesitas tener tu vehículo registrado y verificado.',
          accion: {
            ruta: '/publicar',
            etiquetaBoton: 'Publicar viaje',
          },
        };
      }
      return {
        modo: 'guia',
        mensaje: 'Para publicar viajes como conductor debes registrar tu vehículo desde la app móvil.',
        pasos: [
          'Registra tu vehículo en la app móvil',
          'Espera la validación de tu organización',
          'Publica tus rutas y horarios diarios',
        ],
      };
    }

    // Escrow / Pago en garantía
    if (
      texto.includes('pago') ||
      texto.includes('garantia') ||
      texto.includes('escrow') ||
      texto.includes('cobrar')
    ) {
      return {
        modo: 'guia',
        mensaje:
          'En UniRide el pasaje queda protegido en garantía al reservar y solo se libera al conductor cuando se verifica la bajada.',
        pasos: [
          'Al reservar, tu pasaje queda en garantía',
          'Subes al auto y escanean el código QR en punto de encuentro',
          'Al llegar a destino se confirma la bajada y se paga al conductor',
        ],
        accion:
          cliente === 'movil'
            ? { ruta: '/billetera', etiquetaBoton: 'Ver Billetera' }
            : undefined,
      };
    }

    // Abordaje / QR
    if (
      texto.includes('qr') ||
      texto.includes('abordaje') ||
      texto.includes('subir') ||
      texto.includes('escanear')
    ) {
      return {
        modo: 'guia',
        mensaje:
          'El abordaje se valida criptográficamente mediante doble firma QR y verificación de GPS a menos de 50 metros.',
        pasos: [
          'El conductor muestra el código QR desde su app',
          'El pasajero escanea el código en el punto de encuentro',
          'El servidor valida firmas y cercanía (≤ 50 m)',
        ],
        accion:
          cliente === 'movil'
            ? { ruta: '/mis-viajes', etiquetaBoton: 'Ver mis viajes' }
            : undefined,
      };
    }

    return this.obtenerFallbackGeneral(cliente);
  }

  private obtenerFallbackGeneral(
    cliente: 'movil' | 'web',
  ): RespuestaAsistenteDto {
    return {
      modo: 'guia',
      mensaje:
        'Soy tu Asistente UniRide. Puedo ayudarte a buscar viajes, consultar saldo, entender el sistema de pagos o guiarte en la app.',
      pasos: [
        'Buscar o publicar viajes programados',
        'Revisar tu saldo en garantía en la billetera',
        'Conocer cómo funciona el abordaje seguro con QR',
      ],
      accion:
        cliente === 'movil'
          ? { ruta: '/buscar', etiquetaBoton: 'Explorar viajes' }
          : { ruta: '/', etiquetaBoton: 'Ir al inicio' },
    };
  }
}

