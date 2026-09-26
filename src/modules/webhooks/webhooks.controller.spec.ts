import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { CreateWebhookDto } from './dto/create-webhook.dto.js';
import { WebhookResponseDto } from './dto/webhook-response.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { ThrottlerGuard } from '@nestjs/throttler';

const mockWebhooksService = {
  create: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

function makeWebhookResponse(overrides = {}): WebhookResponseDto {
  return {
    id: 'wh-uuid-1',
    url: 'https://api.example.com/hooks',
    events: ['account.created'],
    isActive: true,
    description: null,
    lastTriggeredAt: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [{ provide: WebhooksService, useValue: mockWebhooksService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  describe('create', () => {
    it('delegates to webhooksService.create and returns the webhook', async () => {
      const dto: CreateWebhookDto = {
        url: 'https://api.example.com/hooks',
        events: ['account.created', 'sweep.completed'],
        secret: 'my-secret',
      };
      const response = makeWebhookResponse();
      mockWebhooksService.create.mockResolvedValue(response);

      const result = await controller.create(dto);

      expect(mockWebhooksService.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(response);
    });

    it('passes through webhooks without optional fields', async () => {
      const dto: CreateWebhookDto = {
        url: 'https://api.example.com/hooks',
        events: ['account.expired'],
      };
      const response = makeWebhookResponse({ description: null });
      mockWebhooksService.create.mockResolvedValue(response);

      const result = await controller.create(dto);

      expect(result.description).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns a list of active webhooks', async () => {
      const webhooks = [
        makeWebhookResponse(),
        makeWebhookResponse({ id: 'wh-uuid-2' }),
      ];
      mockWebhooksService.findAll.mockResolvedValue({
        webhooks,
        total: webhooks.length,
      });

      const result = await controller.findAll();

      expect(mockWebhooksService.findAll).toHaveBeenCalledWith(50, 0);
      expect(result.webhooks).toHaveLength(2);
    });

    it('returns an empty list when no webhooks exist', async () => {
      mockWebhooksService.findAll.mockResolvedValue({
        webhooks: [],
        total: 0,
      });

      const result = await controller.findAll();

      expect(result).toEqual({ webhooks: [], total: 0 });
    });
  });

  describe('update', () => {
    it('delegates to webhooksService.update and returns the updated webhook', async () => {
      const dto = {
        url: 'https://updated.example.com/hook',
        events: ['account.created'],
        description: 'Updated webhook',
      };

      const response = makeWebhookResponse({
        url: dto.url,
        events: dto.events,
        description: dto.description,
      });

      mockWebhooksService.update.mockResolvedValue(response);

      const result = await controller.update('wh-uuid-1', dto);

      expect(mockWebhooksService.update).toHaveBeenCalledWith('wh-uuid-1', dto);

      expect(result).toEqual(response);
    });
  });

  describe('remove', () => {
    it('delegates to webhooksService.remove', async () => {
      mockWebhooksService.remove.mockResolvedValue(undefined);

      await controller.remove('wh-uuid-1');

      expect(mockWebhooksService.remove).toHaveBeenCalledWith('wh-uuid-1');
    });
  });
});
