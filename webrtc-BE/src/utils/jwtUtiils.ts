import jwt from "jsonwebtoken";
import * as dotenv from 'dotenv'
import userServices from "../services/userServices";
dotenv.config();

export class JwtUtills {
    static key:string = process.env.secretKey || "KP";

    static generateToken(userId:string):string{
        const token = jwt.sign({userId},this.key,{expiresIn:'24h'})
        return token;
    }

    static verifyToken(token:string):string|object{
        try {
            const decode = jwt.verify(token,this.key)
            
            return decode
        } catch (error) {
            throw new Error('Invalid token');
        }
    }
   
    static async generateJitsiToken(userId: string, roomName: string): Promise<string> {
        const user = await userServices.getUserById(userId);
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            aud: 'jitsi',
            iss: 'chat',
            sub: 'vpaas-magic-cookie-a0a921fbd4364c1d8c15b1151dfc4fe2',
            room: roomName,
            iat: now,
            nbf: now - 10,
            exp: now + 3 * 60 * 60,
            context: {
                features: {
                    livestreaming: true,
                    recording: true,
                    transcription: true,
                    'outbound-call': true,
                    'sip-outbound-call': false
                },
                user: {
                    id: userId,
                    name: user?.username,
                    avatar: user?.avatar,
                    email: user?.email,
                    moderator: false
                }
            }
        };

        const privateKey = (process.env.PRIVATE_KEY ?? '').replace(/\\n/g, '\n');

        const token = jwt.sign(payload, privateKey, {
            algorithm: 'RS256',
            header: {
                alg: "RS256",
                kid: "vpaas-magic-cookie-a0a921fbd4364c1d8c15b1151dfc4fe2/a85696",
            }

        });
        return token;
    }
}
