/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ClaimsController } from './claims.controller.js';
import { ClaimsService } from './claims.service.js';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';

describe('ClaimsController', () => {
  let app: INestApplication;
  let controller: ClaimsController;

  const mockClaimsService = {
    findClaimById: jest.fn().mockResolvedValue({ id: 'test-id' }),
    verifyClaimToken: jest.fn().mockResolvedValue({ valid: true }),
    redeemClaim: jest.fn().mockResolvedValue({ txHash: '0x123' }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClaimsController],
      providers: [
        {
          provide: ClaimsService,
          useValue: mockClaimsService,
        },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ClaimsController>(ClaimsController);
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('Guard configuration', () => {
    it('should not have JwtAuthGuard on the controller', () => {
      const guards = Reflect.getMetadata('__guards__', ClaimsController) || [];
      const hasJwtGuard = guards.some(
        (guard: any) => guard === JwtAuthGuard || guard.name === 'JwtAuthGuard',
      );
      expect(hasJwtGuard).toBe(false);
    });

    it('should not have JwtAuthGuard on GET /claims/:id', () => {
      const guards =
        Reflect.getMetadata('__guards__', controller.findOne) || [];
      const hasJwtGuard = guards.some(
        (guard: any) => guard === JwtAuthGuard || guard.name === 'JwtAuthGuard',
      );
      expect(hasJwtGuard).toBe(false);
    });

    it('should not have JwtAuthGuard on POST /claims/verify', () => {
      const guards =
        Reflect.getMetadata('__guards__', controller.verifyClaim) || [];
      const hasJwtGuard = guards.some(
        (guard: any) => guard === JwtAuthGuard || guard.name === 'JwtAuthGuard',
      );
      expect(hasJwtGuard).toBe(false);
    });

    it('should not have JwtAuthGuard on POST /claims/redeem', () => {
      const guards = Reflect.getMetadata('__guards__', controller.redeem) || [];
      const hasJwtGuard = guards.some(
        (guard: any) => guard === JwtAuthGuard || guard.name === 'JwtAuthGuard',
      );
      expect(hasJwtGuard).toBe(false);
    });
  });

  describe('Public Endpoints Accessibility', () => {
    it('GET /claims/:id should return 200 without Authorization header', async () => {
      const response = await request(app.getHttpServer()).get(
        '/claims/test-id',
      );
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(200);
      expect(mockClaimsService.findClaimById).toHaveBeenCalledWith('test-id');
    });

    it('POST /claims/verify should return 201 without Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .post('/claims/verify')
        .send({ claimToken: 'test-token' });
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(201);
      expect(mockClaimsService.verifyClaimToken).toHaveBeenCalledWith(
        'test-token',
      );
    });

    it('POST /claims/redeem should return 201 without Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .post('/claims/redeem')
        .send({ claimToken: 'test-token', destinationAddress: 'test-addr' });
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(201);
      expect(mockClaimsService.redeemClaim).toHaveBeenCalledWith(
        'test-token',
        'test-addr',
      );
    });
  });
});
