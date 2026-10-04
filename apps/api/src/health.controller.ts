import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/auth/decorators.js';
import { PrismaService } from './common/prisma/prisma.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check() {
    await this.prisma.raw.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
  }
}
