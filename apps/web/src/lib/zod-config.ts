import { z } from 'zod';

// zod는 처음 검사할 때 new Function으로 eval이 되는지 시험한다. 운영 CSP(script-src 'self')에서는 이 시험이 막히고,
// 막힌 것을 잡아 넘겨도 브라우저가 CSP 위반으로 콘솔에 남긴다. eval 없이 검사하도록 끈다(속도 차이는 화면에서 느낄 수 없다).
z.config({ jitless: true });
