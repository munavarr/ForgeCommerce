import { Body, Controller, Get, Headers, Module, Post, Res } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthService } from './auth.service';
import { CommerceAccess } from '../commerce/access';

@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}
  // Never cache registration, session or identity responses. Credentials are accepted only in JSON bodies.
  private noStore(response: { setHeader(name:string,value:string):unknown }) { response.setHeader('Cache-Control','no-store'); }
  @Post('register') register(@Body() body:unknown, @Res({passthrough:true}) response: {setHeader(name:string,value:string):unknown}) {
    this.noStore(response); return this.auth.register(body);
  }
  @Post('login') login(@Body() body:unknown, @Res({passthrough:true}) response: {setHeader(name:string,value:string):unknown}) {
    this.noStore(response); return this.auth.login(body);
  }
  @Post('logout') logout(@Headers('authorization') header:unknown) { return this.auth.logout(header); }
  @Get('me') me(@Headers('authorization') header:unknown, @Res({passthrough:true}) response: {setHeader(name:string,value:string):unknown}) {
    this.noStore(response); return this.auth.authenticate(header);
  }
}
@Module({imports:[DatabaseModule],providers:[AuthService,CommerceAccess],controllers:[AuthController],exports:[AuthService,CommerceAccess]})
export class AuthModule {}
