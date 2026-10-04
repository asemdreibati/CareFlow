import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Audit, CurrentUser, Public } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ChangePasswordDto, LoginDto, RefreshDto, RegisterClinicDto, SwitchClinicDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @Audit({ action: 'auth.register', entity: 'Clinic' })
  register(@Body() dto: RegisterClinicDto) {
    return this.auth.registerClinic(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @Audit({ action: 'auth.login' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Audit({ skip: true })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  @Audit({ action: 'auth.logout' })
  async logout(@Body() dto: Partial<RefreshDto>, @CurrentUser() user: AuthUser) {
    await this.auth.logout(dto.refreshToken, user.id);
  }

  @ApiBearerAuth()
  @Post('switch-clinic')
  @HttpCode(200)
  @Audit({ action: 'auth.switchClinic' })
  switchClinic(@Body() dto: SwitchClinicDto, @CurrentUser() user: AuthUser) {
    return this.auth.switchClinic(user, dto.clinicId);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(204)
  @Audit({ action: 'auth.changePassword' })
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthUser) {
    await this.auth.changePassword(user, dto);
  }
}
