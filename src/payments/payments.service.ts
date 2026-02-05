import { Inject, Injectable, Logger } from '@nestjs/common';
import { envs, NATS_SERVICE } from 'src/config';
import Stripe from 'stripe';
import { PaymentSessionDto } from './dto/payment-session.dto';
import { Request, Response } from 'express';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class PaymentsService {
  private readonly stripe = new Stripe(envs.stripeSecret);
  private readonly logger = new Logger('paymentsService');

  constructor(@Inject(NATS_SERVICE) private readonly client: ClientProxy) {}

  async createPaymentSession(paymentSessionDto: PaymentSessionDto) {
    const { currency, items, orderId } = paymentSessionDto;

    const lineItems = items.map((item) => {
      return {
        price_data: {
          currency: currency,
          product_data: {
            name: item.name,
          },
          unit_amount: Math.round(item.price * 100), // 20 USD  2000 / 100 = 20.00
        },
        quantity: item.quantity, // Cantidad de productos
      };
    });

    // Integración con Stripe
    const session = await this.stripe.checkout.sessions.create({
      // Colocar aqui el ID de mi orden
      payment_intent_data: {
        metadata: {
          orderId: orderId, // Guardar el ID de la orden en los metadatos
        },
      },

      line_items: lineItems,
      mode: 'payment', // Puede ser 'payment', 'subscription', 'setup'
      success_url: envs.stripeSuccessUrl,
      cancel_url: envs.stripeCancelUrl,
    });

    return {
      calcelUrl: session.cancel_url,
      successUrl: session.success_url,
      url: session.url,
    };
  }

  async stripeWebhook(req: Request, res: Response) {
    const sig = req.headers['stripe-signature'] as string;

    let event: Stripe.Event;

    const endpointSecret = envs.stripeEndpointSecret;

    try {
      event = this.stripe.webhooks.constructEvent(
        req['rawBody'],
        sig,
        endpointSecret,
      );
    } catch (err) {
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    // Manejo de eventos de Stripe
    switch (event.type) {
      case 'charge.succeeded': // Evento de pago exitoso
        const chargeSucceeded = event.data.object;
        const payload = {
          stripePaymentId: chargeSucceeded.id, // ID del pago en Stripe
          orderId: chargeSucceeded.metadata.orderId, // Obtener el ID de la orden desde los metadatos
          receiptUrl: chargeSucceeded.receipt_url, // URL del recibo de pago
        };

        //this.logger.log({ payload }); // Esto es para registrar el pago exitoso
        this.client.emit('payment.succeeded', payload); // Emitir el evento de pago exitoso // Este evento lo va a escuchar el orders.controller.ts
        // El "send" manda el mensaje y espera una respuesta
        // El "emit" manda el mensaje pero no espera respuesta
        break;
      default:
        console.log(`Event ${event.type} no handled`);
    }

    return res.status(200).json({ sig });
  }
}
