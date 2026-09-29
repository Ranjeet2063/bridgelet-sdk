import { Global, Module } from '@nestjs/common';
import { register, Registry } from 'prom-client';

@Global()
@Module({
  providers: [{ provide: Registry, useValue: register }],
  exports: [Registry],
})
export class PromRegistryModule {}