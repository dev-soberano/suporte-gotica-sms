import { 
    useMultiFileAuthState, 
    DisconnectReason, 
    makeCacheableSignalKeyStore, 
    makeWASocket,
    generateWAMessageFromContent,
    normalizeMessageContent,
    getContentType
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import pino from 'pino';
import fs from 'fs';
import readline from 'readline';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import moment from 'moment-timezone';
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUTH_DIR = path.join(__dirname, 'database', 'qr-code');
const USUARIOS_FILE = path.join(__dirname, 'database', 'usuarios.json');
const ID_VOLTAR = 'voltar_menu';
const INTERVALO_SAUDACAO = 24 * 60 * 60 * 1000; // 24h sem falar = recebe o menu de novo
const IDIOMA_PADRAO = 'pt'; // usado se o cliente ignorar os botões de idioma

// =====================================================================
//  ✏️  CONFIGURAÇÃO — edite aqui para adicionar/alterar opções
//  (número e emoji do menu são automáticos pela ordem da lista)
//  Formatação WhatsApp: *negrito*  _itálico_  ~riscado~
//  O itálico das respostas é aplicado automaticamente.
//
//  Cada opção tem:
//   - gatilhos: palavras que ativam a opção (todos os idiomas juntos,
//     sem se preocupar com acentos nem maiúsculas)
//   - textos: título e resposta em pt, en e es
// =====================================================================
const LINK_SUPORTE = 'https://t.me/suporte_gotica_sms';

const HORARIO = {
    pt: 'Segunda a sexta, das 8h às 21h (horário de Brasília)',
    en: 'Monday to Friday, 8 AM to 9 PM (Brasília time)',
    es: 'Lunes a viernes, de 8:00 a 21:00 (hora de Brasilia)'
};

const OPCOES = [
    {
        gatilhos: ['o sms nao chega', 'naochega', 'nao chega', 'not arriving', 'not coming', 'does not arrive', 'doesnt arrive', 'no llega'],
        textos: {
            pt: {
                titulo: 'O SMS não chega',
                resposta:
                    'Se o SMS não chegar ou demorar, você pode *cancelar o número* e gerar outro.\n\n' +
                    '*(Lembrando que o saldo só é debitado quando você recebe o SMS com sucesso).*'
            },
            en: {
                titulo: 'The SMS does not arrive',
                resposta:
                    'If the SMS does not arrive or takes too long, you can *cancel the number* and generate another one.\n\n' +
                    '*(Remember: your balance is only charged when you successfully receive the SMS).*'
            },
            es: {
                titulo: 'El SMS no llega',
                resposta:
                    'Si el SMS no llega o tarda demasiado, puedes *cancelar el número* y generar otro.\n\n' +
                    '*(Recuerda: el saldo solo se descuenta cuando recibes el SMS con éxito).*'
            }
        }
    },
    {
        gatilhos: ['quero receber outro sms', 'outrosms', 'outro sms', 'another sms', 'receive another', 'recibir otro'],
        textos: {
            pt: {
                titulo: 'Quero receber outro SMS',
                resposta:
                    'Infelizmente cada número virtual só pode receber *1 SMS*.\n\n' +
                    'Se você teve algum problema com a plataforma de ativação e eles pediram o SMS novamente, será necessário *adquirir um novo número*.'
            },
            en: {
                titulo: 'I want to receive another SMS',
                resposta:
                    'Unfortunately each virtual number can only receive *1 SMS*.\n\n' +
                    'If you had a problem with the activation platform and they asked for the SMS again, you will need to *get a new number*.'
            },
            es: {
                titulo: 'Quiero recibir otro SMS',
                resposta:
                    'Lamentablemente cada número virtual solo puede recibir *1 SMS*.\n\n' +
                    'Si tuviste algún problema con la plataforma de activación y te pidieron el SMS de nuevo, será necesario *adquirir un nuevo número*.'
            }
        }
    },
    {
        gatilhos: ['numero caiu', 'caiu', 'number dropped', 'dropped', 'se cayo', 'cayo'],
        textos: {
            pt: {
                titulo: 'Recebi e o número caiu',
                resposta:
                    '⚠️ *Aviso Importante:*\n\n' +
                    'Não nos responsabilizamos pela perda do número nem por banimentos ou restrições na plataforma usada.'
            },
            en: {
                titulo: 'I received it and the number dropped',
                resposta:
                    '⚠️ *Important notice:*\n\n' +
                    'We are not responsible for losing the number, nor for bans or restrictions on the platform used.'
            },
            es: {
                titulo: 'Lo recibí y el número se cayó',
                resposta:
                    '⚠️ *Aviso importante:*\n\n' +
                    'No nos responsabilizamos por la pérdida del número ni por baneos o restricciones en la plataforma utilizada.'
            }
        }
    },
    {
        gatilhos: ['nao funcionou', 'invalido', 'incorreto', 'codigo errado', 'not work', 'didnt work', "didn't work", 'invalid', 'wrong code', 'no funciono', 'no funciona'],
        textos: {
            pt: {
                titulo: 'O código chegou e não funcionou',
                resposta:
                    '*1️⃣ Primeiro passo:*\n' +
                    'Tente *reenviar o código* no serviço.\n\n' +
                    '*2️⃣ Se não funcionar:*\n' +
                    '*GRAVE um vídeo* mostrando o código sendo inserido no aplicativo, junto com o código sendo exibido no bot, e envie para o suporte humano no Telegram:\n\n' +
                    `👉 ${LINK_SUPORTE}`
            },
            en: {
                titulo: 'The code arrived but did not work',
                resposta:
                    '*1️⃣ First step:*\n' +
                    'Try *resending the code* in the service.\n\n' +
                    '*2️⃣ If it still does not work:*\n' +
                    '*RECORD a video* showing the code being entered in the app, together with the code displayed in the bot, and send it to human support on Telegram:\n\n' +
                    `👉 ${LINK_SUPORTE}`
            },
            es: {
                titulo: 'El código llegó y no funcionó',
                resposta:
                    '*1️⃣ Primer paso:*\n' +
                    'Intenta *reenviar el código* en el servicio.\n\n' +
                    '*2️⃣ Si no funciona:*\n' +
                    '*GRABA un video* mostrando el código siendo ingresado en la aplicación, junto con el código mostrado en el bot, y envíalo al soporte humano en Telegram:\n\n' +
                    `👉 ${LINK_SUPORTE}`
            }
        }
    },
    {
        gatilhos: ['banido', 'ja usado', 'ja foi usado', 'banned', 'already used', 'baneado', 'ya usado', 'ya fue usado', 'ya utilizado'],
        textos: {
            pt: {
                titulo: 'Número banido ou já usado',
                resposta:
                    'Se o seu número já chegou *banido* ou *já usado*, grave um vídeo mostrando:\n\n' +
                    '• o aplicativo que está sendo ativado (ex: WhatsApp) com a mensagem de banimento/uso;\n' +
                    '• a mensagem de ativação do bot exibindo o código recebido.\n\n' +
                    '*Depois envie para o suporte humano no Telegram:*\n\n' +
                    `👉 ${LINK_SUPORTE}`
            },
            en: {
                titulo: 'Banned or already used number',
                resposta:
                    'If your number arrived *banned* or *already used*, record a video showing:\n\n' +
                    '• the app being activated (e.g. WhatsApp) with the ban/used message;\n' +
                    '• the bot activation message showing the received code.\n\n' +
                    '*Then send it to human support on Telegram:*\n\n' +
                    `👉 ${LINK_SUPORTE}`
            },
            es: {
                titulo: 'Número baneado o ya usado',
                resposta:
                    'Si tu número llegó *baneado* o *ya usado*, graba un video mostrando:\n\n' +
                    '• la aplicación que se está activando (ej: WhatsApp) con el mensaje de baneo/uso;\n' +
                    '• el mensaje de activación del bot mostrando el código recibido.\n\n' +
                    '*Luego envíalo al soporte humano en Telegram:*\n\n' +
                    `👉 ${LINK_SUPORTE}`
            }
        }
    },
    {
        gatilhos: ['indisponivel', 'nao encontra', 'sem numero', 'unavailable', 'out of stock', 'no number', 'cannot find', 'no disponible', 'sin numero', 'no encuentra'],
        textos: {
            pt: {
                titulo: 'Serviço indisponível / sem número',
                resposta:
                    '🔧 *Serviço indisponível:*\n' +
                    'Aguarde alguns minutos e tente novamente. Os números são *reabastecidos a cada 1 hora*.\n\n' +
                    '🔎 *Bot não encontra número:*\n' +
                    'Tente comprar de novo. Se continuar, aguarde alguns minutos e tente outra vez.'
            },
            en: {
                titulo: 'Service unavailable / no numbers',
                resposta:
                    '🔧 *Service unavailable:*\n' +
                    'Wait a few minutes and try again. Numbers are *restocked every 1 hour*.\n\n' +
                    '🔎 *Bot cannot find a number:*\n' +
                    'Try buying again. If it continues, wait a few minutes and try once more.'
            },
            es: {
                titulo: 'Servicio no disponible / sin números',
                resposta:
                    '🔧 *Servicio no disponible:*\n' +
                    'Espera unos minutos e inténtalo de nuevo. Los números se *reabastecen cada 1 hora*.\n\n' +
                    '🔎 *El bot no encuentra números:*\n' +
                    'Intenta comprar de nuevo. Si continúa, espera unos minutos e inténtalo otra vez.'
            }
        }
    },
    {
        gatilhos: ['cancel', 'limit', 'bloque', 'block'],
        textos: {
            pt: {
                titulo: 'Como cancelar um número?',
                resposta:
                    'Se você *não recebeu nenhum código*, pode cancelar o número e o valor *volta para o seu saldo* no bot.\n\n' +
                    '⚠️ *Atenção:*\n' +
                    'Cancelamentos sucessivos e repetidos podem gerar *bloqueio temporário* de novas compras.'
            },
            en: {
                titulo: 'How do I cancel a number?',
                resposta:
                    'If you *did not receive any code*, you can cancel the number and the amount *returns to your balance* in the bot.\n\n' +
                    '⚠️ *Warning:*\n' +
                    'Repeated successive cancellations may cause a *temporary block* on new purchases.'
            },
            es: {
                titulo: '¿Cómo cancelar un número?',
                resposta:
                    'Si *no recibiste ningún código*, puedes cancelar el número y el valor *vuelve a tu saldo* en el bot.\n\n' +
                    '⚠️ *Atención:*\n' +
                    'Las cancelaciones sucesivas y repetidas pueden generar un *bloqueo temporal* de nuevas compras.'
            }
        }
    },
    {
        gatilhos: ['quanto tempo dura', 'quanto tempo duram', 'tempo de uso', 'duram', 'reembolso', 'how long does the number', 'how long do the number', 'number last', 'permanent', 'refund', 'cuanto dura', 'cuanto duran'],
        textos: {
            pt: {
                titulo: 'Quanto tempo dura o número?',
                resposta:
                    '♾️ *Os números são permanentes:*\n' +
                    'Depois que você cria a conta (ex: WhatsApp), o número *não tem tempo de uso*. Ele dura até ser *banido* ou até você *desconectá-lo* do aplicativo.\n\n' +
                    '⏱️ *Tempo para receber o código:*\n' +
                    'O número fica disponível por *20 minutos* para receber o SMS. Se não chegar, é só cancelar e gerar outro.\n\n' +
                    '💰 *Reembolso:*\n' +
                    '*Não reembolsamos* números após 1 hora de solicitado.'
            },
            en: {
                titulo: 'How long does the number last?',
                resposta:
                    '♾️ *Numbers are permanent:*\n' +
                    'Once you create the account (e.g. WhatsApp), the number has *no usage time limit*. It lasts until it is *banned* or until you *disconnect it* from the app.\n\n' +
                    '⏱️ *Time to receive the code:*\n' +
                    'The number is available for *20 minutes* to receive the SMS. If it does not arrive, just cancel and generate another.\n\n' +
                    '💰 *Refunds:*\n' +
                    'We *do not refund* numbers after 1 hour from the request.'
            },
            es: {
                titulo: '¿Cuánto dura el número?',
                resposta:
                    '♾️ *Los números son permanentes:*\n' +
                    'Una vez que creas la cuenta (ej: WhatsApp), el número *no tiene tiempo de uso*. Dura hasta ser *baneado* o hasta que lo *desconectes* de la aplicación.\n\n' +
                    '⏱️ *Tiempo para recibir el código:*\n' +
                    'El número está disponible por *20 minutos* para recibir el SMS. Si no llega, solo cancela y genera otro.\n\n' +
                    '💰 *Reembolso:*\n' +
                    '*No reembolsamos* números después de 1 hora de solicitado.'
            }
        }
    },
    {
        gatilhos: ['como funciona', 'como comprar', 'quanto tempo demora', 'how it works', 'how does it work', 'how to buy', 'how long does the sms', 'sms take', 'cuanto tarda', 'tarda el sms'],
        textos: {
            pt: {
                titulo: 'Como funciona a compra? Quanto demora o SMS?',
                resposta:
                    '🛒 *Compra:*\n' +
                    'Você escolhe o *serviço* (o aplicativo ou site onde vai usar o número) e recebe SMS *somente daquele serviço* escolhido.\n\n' +
                    '⏳ *Tempo do código:*\n' +
                    'Geralmente até *30 segundos*, mas em alguns casos pode levar até *3 minutos*.'
            },
            en: {
                titulo: 'How does buying work? How long does the SMS take?',
                resposta:
                    '🛒 *Purchase:*\n' +
                    'You choose the *service* (the app or site where you will use the number) and receive SMS *only from that chosen service*.\n\n' +
                    '⏳ *Code time:*\n' +
                    'Usually up to *30 seconds*, but in some cases it can take up to *3 minutes*.'
            },
            es: {
                titulo: '¿Cómo funciona la compra? ¿Cuánto tarda el SMS?',
                resposta:
                    '🛒 *Compra:*\n' +
                    'Eliges el *servicio* (la aplicación o sitio donde usarás el número) y recibes SMS *solo de ese servicio* elegido.\n\n' +
                    '⏳ *Tiempo del código:*\n' +
                    'Generalmente hasta *30 segundos*, pero en algunos casos puede tardar hasta *3 minutos*.'
            }
        }
    },
    {
        gatilhos: ['pais', 'operadora', 'ddd', 'country', 'carrier', 'operator', 'area code', 'operador', 'codigo de area'],
        textos: {
            pt: {
                titulo: 'Posso escolher país, operadora ou DDD?',
                resposta:
                    '🌎 *País:*\n' +
                    'Sim, temos uma grande variedade de países disponíveis.\n\n' +
                    '📶 *Operadora:*\n' +
                    'Não é possível escolher, os números são gerados com operadora aleatória.\n\n' +
                    '📍 *DDD:*\n' +
                    'Não é possível escolher, os números vêm com DDDs aleatórios.'
            },
            en: {
                titulo: 'Can I choose country, carrier or area code?',
                resposta:
                    '🌎 *Country:*\n' +
                    'Yes, we have a wide variety of countries available.\n\n' +
                    '📶 *Carrier:*\n' +
                    'Not possible to choose, numbers are generated with a random carrier.\n\n' +
                    '📍 *Area code:*\n' +
                    'Not possible to choose, numbers come with random area codes.'
            },
            es: {
                titulo: '¿Puedo elegir país, operador o código de área?',
                resposta:
                    '🌎 *País:*\n' +
                    'Sí, tenemos una gran variedad de países disponibles.\n\n' +
                    '📶 *Operador:*\n' +
                    'No es posible elegir, los números se generan con operador aleatorio.\n\n' +
                    '📍 *Código de área:*\n' +
                    'No es posible elegir, los números vienen con códigos de área aleatorios.'
            }
        }
    },
    {
        gatilhos: ['atendente', 'humano', 'falar com', 'agent', 'human', 'talk to', 'support', 'agente', 'hablar con', 'soporte'],
        textos: {
            pt: {
                titulo: 'Falar com o atendente',
                resposta:
                    '⚠️ *Antes de chamar o suporte:*\n' +
                    'Chame o atendente *somente se você leu as opções acima e o seu problema não foi resolvido*.\n\n' +
                    '🕗 *Horário de atendimento:*\n' +
                    `${HORARIO.pt}.\n\n` +
                    '📞 *Suporte humano no Telegram:*\n\n' +
                    `👉 ${LINK_SUPORTE}`
            },
            en: {
                titulo: 'Talk to an agent',
                resposta:
                    '⚠️ *Before contacting support:*\n' +
                    'Contact an agent *only if you have read the options above and your problem was not solved*.\n\n' +
                    '🕗 *Support hours:*\n' +
                    `${HORARIO.en}.\n\n` +
                    '📞 *Human support on Telegram:*\n\n' +
                    `👉 ${LINK_SUPORTE}`
            },
            es: {
                titulo: 'Hablar con un agente',
                resposta:
                    '⚠️ *Antes de llamar al soporte:*\n' +
                    'Contacta al agente *solo si leíste las opciones anteriores y tu problema no fue resuelto*.\n\n' +
                    '🕗 *Horario de atención:*\n' +
                    `${HORARIO.es}.\n\n` +
                    '📞 *Soporte humano en Telegram:*\n\n' +
                    `👉 ${LINK_SUPORTE}`
            }
        }
    }

    // Para adicionar outra opção, copie o bloco abaixo (lembre da vírgula antes):
    // ,{
    //     gatilhos: ['palavra pt', 'word en', 'palabra es'],
    //     textos: {
    //         pt: { titulo: 'Título', resposta: '*Subtítulo:*\nTexto aqui.' },
    //         en: { titulo: 'Title',  resposta: '*Subtitle:*\nText here.' },
    //         es: { titulo: 'Título', resposta: '*Subtítulo:*\nTexto aquí.' }
    //     }
    // }
];

// Textos fixos da interface, por idioma
const I18N = {
    pt: {
        nomeSuporte: 'SUPORTE - GÓTICA SMS',
        cliente: 'Cliente',
        ola: 'Olá',
        bemVindo: 'Seja bem-vindo(a) ao suporte automatizado da Gótica SMS!',
        digite: 'Digite o número abaixo 👇',
        voltarBtn: 'Voltar ao menu',
        voltarTexto: 'Digite *0* para voltar ao menu.',
        manha: 'Bom dia! ☀️', tarde: 'Boa tarde! 🌤️', noite: 'Boa noite! 🌙'
    },
    en: {
        nomeSuporte: 'SUPPORT - GÓTICA SMS',
        cliente: 'Customer',
        ola: 'Hello',
        bemVindo: 'Welcome to Gótica SMS automated support!',
        digite: 'Type the number below 👇',
        voltarBtn: 'Back to menu',
        voltarTexto: 'Type *0* to go back to the menu.',
        manha: 'Good morning! ☀️', tarde: 'Good afternoon! 🌤️', noite: 'Good evening! 🌙'
    },
    es: {
        nomeSuporte: 'SOPORTE - GÓTICA SMS',
        cliente: 'Cliente',
        ola: 'Hola',
        bemVindo: '¡Bienvenido(a) al soporte automatizado de Gótica SMS!',
        digite: 'Escribe el número abajo 👇',
        voltarBtn: 'Volver al menú',
        voltarTexto: 'Escribe *0* para volver al menú.',
        manha: '¡Buenos días! ☀️', tarde: '¡Buenas tardes! 🌤️', noite: '¡Buenas noches! 🌙'
    }
};

// Botões de escolha de idioma (enviados UMA vez por cliente)
const IDIOMAS = [
    { id: 'lang_pt', lang: 'pt', botao: '🇧🇷 Português' },
    { id: 'lang_en', lang: 'en', botao: '🇺🇸 English' },
    { id: 'lang_es', lang: 'es', botao: '🇪🇸 Español' }
];
const TEXTO_SELETOR =
    '🌐 *Gótica SMS*\n\n' +
    '🇧🇷 _Escolha o seu idioma_\n' +
    '🇺🇸 _Choose your language_\n' +
    '🇪🇸 _Elige tu idioma_';
const TEXTO_SELETOR_FALLBACK = '_Digite / Type / Escribe:_ *PT* · *EN* · *ES*';

// Textos que significam "voltar ao menu"
const COMANDOS_VOLTAR = [
    ID_VOLTAR, '0', 'voltar', 'voltar ao menu', 'back', 'back to menu', 'volver', 'volver al menu'
];
// =====================================================================

// Numeração e emoji automáticos pela ordem da lista
const EMOJIS_NUM = { 0: '0️⃣', 1: '1️⃣', 2: '2️⃣', 3: '3️⃣', 4: '4️⃣', 5: '5️⃣', 6: '6️⃣', 7: '7️⃣', 8: '8️⃣', 9: '9️⃣' };
function emojiNumero(n) {
    if (n === 10) return '🔟';
    return String(n).split('').map(d => EMOJIS_NUM[d]).join('');
}
OPCOES.forEach((o, i) => {
    o.numero = String(i + 1);
    o.emoji = emojiNumero(i + 1);
});

// Remove acentos e deixa minúsculo (para comparar mensagens)
function normalizar(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

// Aplica itálico linha por linha (linhas com link ficam sem itálico, senão o link quebra)
function italico(texto) {
    return texto
        .split('\n')
        .map(linha => {
            const t = linha.trim();
            if (!t || /https?:\/\//i.test(t)) return t;
            return `_${t}_`;
        })
        .join('\n');
}

// Guarda mensagens enviadas para o WhatsApp poder pedir reenvio
const mensagensEnviadas = new Map();
function guardarMensagem(id, message) {
    if (!id || !message) return;
    mensagensEnviadas.set(id, message);
    if (mensagensEnviadas.size > 500) {
        mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
    }
}

// ---------- Dados dos clientes (idioma + última mensagem) ----------
let usuarios = {};
try {
    if (fs.existsSync(USUARIOS_FILE)) {
        usuarios = JSON.parse(fs.readFileSync(USUARIOS_FILE, 'utf-8'));
    }
} catch {
    usuarios = {};
}

function salvarUsuarios() {
    try {
        fs.mkdirSync(path.dirname(USUARIOS_FILE), { recursive: true });
        fs.writeFileSync(USUARIOS_FILE, JSON.stringify(usuarios));
    } catch (e) {
        console.error('❌ Erro ao salvar usuarios:', e.message);
    }
}

function atualizarUsuario(chatId, dados) {
    usuarios[chatId] = { ...(usuarios[chatId] || {}), ...dados };
    salvarUsuarios();
}

// ---------- Login: QR Code ou código de pareamento ----------
let metodoLogin = null;  // 'qr' | 'codigo'
let numeroLogin = null;  // número do bot (só dígitos, com DDI)

function perguntar(pergunta) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(pergunta, resposta => {
            rl.close();
            resolve(resposta.trim());
        });
    });
}

async function escolherLogin() {
    if (metodoLogin) return; // já escolhido (reconexões não perguntam de novo)

    console.log('\n📲 Como deseja conectar o WhatsApp?\n');
    console.log('  1 - QR Code');
    console.log('  2 - Código de pareamento (8 dígitos)\n');

    let opcao = '';
    while (!['1', '2'].includes(opcao)) {
        opcao = await perguntar('Digite 1 ou 2: ');
    }

    if (opcao === '2') {
        let numero = '';
        while (numero.length < 10) {
            const resp = await perguntar('\nDigite o número do WhatsApp do bot com DDI e DDD (ex: 5563999999999): ');
            numero = resp.replace(/\D/g, '');
        }
        numeroLogin = numero;
        metodoLogin = 'codigo';
    } else {
        metodoLogin = 'qr';
    }
}

// ---------- Utilidades ----------
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout (${ms}ms) em: ${label}`)), ms)
        )
    ]);
}

function ucapan(lang) {
    const t = I18N[lang];
    const time = Number(moment.tz('America/Sao_Paulo').format('HH'));
    if (time >= 5 && time < 12) return t.manha;
    if (time >= 12 && time < 18) return t.tarde;
    return t.noite;
}

// Menu montado automaticamente a partir de OPCOES no idioma do cliente
function getMenuTexto(pushName, lang) {
    const t = I18N[lang];
    const lista = OPCOES.map(o => `${o.emoji} ${o.textos[lang].titulo}`).join('\n');
    return `*${t.nomeSuporte}*\n\n` +
           `${t.ola} *${pushName || t.cliente}*, ${ucapan(lang)}\n\n` +
           `_${t.bemVindo}_\n\n` +
           `${lista}\n\n` +
           `> ${t.digite}`;
}

function acharOpcao(comando) {
    // 1º: número exato
    const porNumero = OPCOES.find(o => comando === o.numero);
    if (porNumero) return porNumero;

    // 2º: palavras-chave (qualquer idioma)
    return OPCOES.find(o => o.gatilhos.some(g => comando.includes(g)));
}

// Detecta o idioma em UM texto (clique no botão ou texto digitado: PT, EN, ES, english...)
function detectarIdioma(c) {
    if (!c) return null;
    if (c.includes('lang_pt') || c === 'pt' || c.includes('portugues') || c.includes('portuguese')) return 'pt';
    if (c.includes('lang_en') || c === 'en' || c.includes('english') || c.includes('ingles')) return 'en';
    if (c.includes('lang_es') || c === 'es' || c.includes('espanol') || c.includes('spanish') || c.includes('espanhol')) return 'es';
    return null;
}

async function enviarTexto(conn, chatId, text) {
    const sent = await conn.sendMessage(chatId, { text });
    if (sent?.key?.id) guardarMensagem(sent.key.id, sent.message);
    return sent;
}

// Lê TODOS os textos possíveis da mensagem (texto digitado ou clique de botão,
// em qualquer formato) e devolve uma lista já normalizada
function extrairCandidatos(rawMessage) {
    const msg = normalizeMessageContent(rawMessage) || rawMessage || {};
    const tipo = getContentType(msg);
    const candidatos = [];
    const add = (v) => {
        if (v && typeof v === 'string') {
            const n = normalizar(v);
            if (n) candidatos.push(n);
        }
    };

    // Botão nativo (nativeFlow)
    const resp = msg.interactiveResponseMessage;
    if (resp) {
        try {
            const p = JSON.parse(resp.nativeFlowResponseMessage?.paramsJson || '{}');
            add(p.id);
            add(p.display_text);
            add(p.title);
        } catch {}
        add(resp.body?.text);
    }

    // Outros formatos de clique
    add(msg.buttonsResponseMessage?.selectedButtonId);
    add(msg.buttonsResponseMessage?.selectedDisplayText);
    add(msg.templateButtonReplyMessage?.selectedId);
    add(msg.templateButtonReplyMessage?.selectedDisplayText);
    add(msg.listResponseMessage?.singleSelectReply?.selectedRowId);
    add(msg.listResponseMessage?.title);

    // Texto digitado
    add(msg.conversation);
    add(msg.extendedTextMessage?.text);
    add(msg.imageMessage?.caption);
    add(msg.videoMessage?.caption);

    return { tipo, candidatos };
}

// Nós que o WhatsApp exige para renderizar botões nativos
function buildInteractiveNodes(chatId) {
    const nodes = [
        {
            tag: 'biz',
            attrs: {},
            content: [
                {
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [
                        { tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }
                    ]
                }
            ]
        }
    ];

    if (!chatId.endsWith('@g.us')) {
        nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    }

    return nodes;
}

// Envia mensagem com botões; se falhar, manda só o texto de reserva
async function enviarComBotoes(conn, chatId, corpo, botoes, textoReserva) {
    try {
        const interactiveMessage = {
            header: { hasMediaAttachment: false },
            body: { text: corpo },
            nativeFlowMessage: {
                buttons: botoes.map(b => ({
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({ display_text: b.texto, id: b.id })
                }))
            }
        };

        const msgi = generateWAMessageFromContent(chatId, {
            interactiveMessage
        }, { userJid: conn.user.id });

        guardarMensagem(msgi.key.id, msgi.message);

        await withTimeout(
            conn.relayMessage(chatId, msgi.message, {
                messageId: msgi.key.id,
                additionalNodes: buildInteractiveNodes(chatId)
            }),
            15000,
            'relayMessage (botões)'
        );
    } catch (err) {
        console.error('⚠️ Falha nos botões, enviando em texto:', err.message);
        await enviarTexto(conn, chatId, `${corpo}\n\n${textoReserva}`);
    }
}

// Saudação da primeira mensagem: 3 botões de idioma
async function enviarSeletorIdioma(conn, chatId) {
    await enviarComBotoes(
        conn, chatId,
        TEXTO_SELETOR,
        IDIOMAS.map(i => ({ texto: i.botao, id: i.id })),
        TEXTO_SELETOR_FALLBACK
    );
}

// Resposta (título em negrito, corpo em itálico) + botão "Voltar ao menu"
async function enviarResposta(conn, chatId, lang, titulo, descricao) {
    const t = I18N[lang];
    const corpo = `📌 *${titulo.toUpperCase()}*\n\n${italico(descricao)}`;
    await enviarComBotoes(
        conn, chatId,
        corpo,
        [{ texto: t.voltarBtn, id: ID_VOLTAR }],
        `_${t.voltarTexto}_`
    );
}

// ---------- Processamento de cada mensagem ----------
async function processarMensagem(conn, m) {
    if (!m.message || m.key.fromMe) return;

    const chatId = m.key.remoteJid;

    if (chatId.endsWith('@g.us') || chatId === 'status@broadcast') return;

    const { tipo, candidatos } = extrairCandidatos(m.message);
    const comando = candidatos[0] || '';
    const pushName = m.pushName;

    console.log(`[MENSAGEM] De: ${chatId} | Tipo: ${tipo} | Conteúdo: ${candidatos.join(' | ') || '(vazio)'}`);
    if (!candidatos.length) {
        console.log('[DEBUG] Mensagem sem texto reconhecido:', JSON.stringify(m.message).slice(0, 800));
    }

    try {
        const agora = Date.now();
        const usuario = usuarios[chatId] || {};
        const passouIntervalo = agora - (usuario.ultima || 0) > INTERVALO_SAUDACAO;

        // 1) Cliente escolheu/digitou um idioma (botão, PT, EN, ES...) -> salva e manda o menu
        const idiomaEscolhido = candidatos.map(detectarIdioma).find(Boolean);
        if (idiomaEscolhido) {
            atualizarUsuario(chatId, { lang: idiomaEscolhido, seletor: true, ultima: agora });
            await enviarTexto(conn, chatId, getMenuTexto(pushName, idiomaEscolhido));
            return;
        }

        // 2) Primeira mensagem do cliente: manda os 3 botões de idioma (UMA única vez)
        if (!usuario.lang && !usuario.seletor) {
            atualizarUsuario(chatId, { seletor: true, ultima: agora });
            await enviarSeletorIdioma(conn, chatId);
            return;
        }

        // 3) Cliente ignorou os botões -> assume o idioma padrão e segue normalmente
        let lang = usuario.lang;
        if (!lang) {
            lang = IDIOMA_PADRAO;
            atualizarUsuario(chatId, { lang, ultima: agora });
        } else {
            atualizarUsuario(chatId, { ultima: agora });
        }

        // 4) Voltar ao menu (botão ou texto)
        if (candidatos.some(c => COMANDOS_VOLTAR.includes(c))) {
            await enviarTexto(conn, chatId, getMenuTexto(pushName, lang));
            return;
        }

        // 5) Voltou após 24h -> saudação com o menu no idioma salvo
        if (passouIntervalo) {
            await enviarTexto(conn, chatId, getMenuTexto(pushName, lang));
            return;
        }

        // 6) Opção do menu
        const opcao = acharOpcao(comando);

        if (opcao) {
            const { titulo, resposta } = opcao.textos[lang];
            await enviarResposta(conn, chatId, lang, titulo, resposta);
        } else {
            await enviarTexto(conn, chatId, getMenuTexto(pushName, lang));
        }

    } catch (err) {
        console.error("❌ Erro ao enviar mensagem:", err);
    }
}

// ---------- Bot ----------
async function startGoticaBot() {
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = [2, 3000, 1043857760];

    // Só pergunta o método de login se o bot ainda não estiver conectado
    if (!state.creds.registered) {
        await escolherLogin();
    }
    
    console.log(`[GOTICA BOT] Inicializando conexão...`);

    const conn = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        msgRetryCounterCache: new NodeCache(),
        getMessage: async (key) => mensagensEnviadas.get(key.id) || undefined,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        browser: ["Ubuntu", "Chrome", "22.0.0.0"]
    });

    let codigoSolicitado = false;

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // O evento "qr" indica que o socket está pronto para registrar o aparelho
        if (qr && !conn.authState.creds.registered) {
            if (metodoLogin === 'codigo') {
                if (!codigoSolicitado) {
                    codigoSolicitado = true;
                    try {
                        const codigo = await conn.requestPairingCode(numeroLogin);
                        const formatado = codigo?.match(/.{1,4}/g)?.join('-') || codigo;
                        console.log(`\n🔑 Seu código de pareamento: \x1b[32m${formatado}\x1b[0m\n`);
                        console.log('No WhatsApp do bot: Configurações > Aparelhos conectados > Conectar um aparelho > Conectar com número de telefone, e digite o código acima.\n');
                    } catch (err) {
                        codigoSolicitado = false;
                        console.error('❌ Erro ao gerar o código de pareamento:', err.message);
                    }
                }
            } else {
                console.log('\n📲 Escaneie o QR Code abaixo com o WhatsApp do bot:\n');
                qrcode.generate(qr, { small: true });
            }
        }

        if (connection === 'open') {
            console.log('\n🖤 \x1b[32m[GOTICA BOT] Conectado com sucesso ao WhatsApp!\x1b[0m\n');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`⚠️ Conexão fechada. Motivo:`, lastDisconnect?.error?.message || statusCode);

            if (shouldReconnect) {
                console.log('🔄 Reconectando automaticamente em 3 segundos...');
                setTimeout(() => startGoticaBot(), 3000);
            } else {
                console.log('❌ Bot Deslogado pelo WhatsApp. Apague a pasta database/qr-code e inicie de novo.');
            }
        }
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
            await processarMensagem(conn, m);
        }
    });
}

startGoticaBot();