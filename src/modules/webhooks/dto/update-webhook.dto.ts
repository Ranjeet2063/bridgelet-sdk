import {
  IsUrl,
  IsArray,
  IsString,
  IsOptional,
  IsBoolean,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateWebhookDto {
  @ApiProperty({
    required: false,
    example: 'https://api.example.com/hooks',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiProperty({
    required: false,
    example: [
      'sweep.completed',
      'sweep.failed',
      'account.created',
      'account.expired',
    ],
    description: 'Event types to subscribe to',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ApiProperty({
    required: false,
    example: 'Payroll completion hook',
    description: 'Optional description for the webhook subscription',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    description: 'Pause (false) or resume (true) delivery for this webhook',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    required: false,
    description:
      'New secret used to sign outbound payloads (rotates the existing one)',
  })
  @IsOptional()
  @IsString()
  @MinLength(16, { message: 'secret must be at least 16 characters long' })
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'secret may only contain letters, numbers, "_" and "-"',
  })
  secret?: string;
}
