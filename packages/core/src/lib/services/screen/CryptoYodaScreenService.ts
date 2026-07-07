import { inject } from "../../core/di";
import LoggerService from "../base/LoggerService";
import TYPES from "../../core/types";
import { ParseFormat } from "../../../model/ParseFormat.model";
import ParserService from "../core/ParserService";
import { ScraperMessage } from "../../../model/ScraperMessage.model";
import { ParserMessage } from "../../../model/ParserMessage.model";
import ScraperService from "../core/ScraperService";
import { CC_CHANNEL_LIST } from "../../../config/params";

// Тип-маркер семейства шаблона (риск-гейт и crawler фильтруют по нему);
// фактический канал каждого сообщения — в поле channel (см. CC_CHANNEL_LIST).
const CHANNEL_NAME = "crypto_yoda_channel" as const;

const num = (s: string) => parseFloat(s.replace(",", "."));
const isNum = (v: number) => Number.isFinite(v) && v > 0;

type SignalFields = {
    symbol: string;
    direction: "short" | "long";
    entry: { from: number; to: number };
    targets: number[];
    stoploss: number;
};

const SIGNAL_FORMAT: ParseFormat<SignalFields> = {
    symbol: {
        pattern: /#([A-Z0-9]+)\/USDT/,
        group: 1,
        validate: (v) => v.length > 0,
    },
    direction: {
        pattern: /(ШОРТ|ЛОНГ)/i,
        transform: (raw) => (raw.toUpperCase() === "ШОРТ" ? "short" : "long"),
        validate: (v) => v === "short" || v === "long",
    },
    entry: {
        pattern: /зоне\s+\$?([\d.,]+)\s*[-–—]\s*(?:\$?[\d.,]+\s*[-–—]\s*)?\$?([\d.,]+)(?=\s)/i,
        transform: (_, m) => ({ from: num(m[1]), to: num(m[2]) }),
        validate: (v) => isNum(v.from) && isNum(v.to) && v.from < v.to,
    },
    targets: {
        pattern: /Закрыть(?:\s+ордер)?\s+по(?:\s+цене)?\s+\$?([\d.,]+)/gi,
        transform: (_, m) => num(m[1]),
        validate: (v) => isNum(v),
        multi: true,
    },
    stoploss: {
        // ФОРК-ПРАВКА: июль-2026 шаблон канала пишет «СТОП ЛОСС» с пробелом
        // (живые посты 2026-07-07, id 5698/5699/5700) — допускаем дефис/пробел/
        // слитно, как в нашем parse_signals.mjs (paperhands/pump_bench).
        pattern: /СТОП[-\s]?ЛОСС:\s*\$?([\d.,]+)/i,
        transform: (_, m) => num(m[1]),
        validate: (v) => isNum(v),
    },
};

export class CryptoYodaScreenService {
    private readonly loggerService = inject<LoggerService>(TYPES.loggerService);
    private readonly parserService = inject<ParserService>(TYPES.parserService);
    private readonly scraperService = inject<ScraperService>(TYPES.scraperService);

    public parseDay = async (
        scraperList: ScraperMessage[],
    ): Promise<ParserMessage<typeof SIGNAL_FORMAT, typeof CHANNEL_NAME>[]> => {
        this.loggerService.log("cryptoYodaScreenService parseDay", {
            scraperListLen: scraperList.length,
        });
        const parserList = await this.parserService.parseDay(scraperList, SIGNAL_FORMAT);
        return parserList.map((msg) => ({ ...msg, type: CHANNEL_NAME }));
    }

    // ФОРК-ПРАВКА: мультиканальность — скрейпим все каналы из CC_CHANNEL_LIST
    // (дефолт — только crypto_yoda_channel, поведение апстрима не меняется).
    // Последовательно, не Promise.all: MTProto-флуд-лимиты на user-session.
    public screenDay = async (date: Date) => {
        this.loggerService.log("cryptoYodaScreenService screenDay", {
            date,
            channelList: CC_CHANNEL_LIST,
        });
        const resultList: ParserMessage<typeof SIGNAL_FORMAT, typeof CHANNEL_NAME>[] = [];
        for (const channel of CC_CHANNEL_LIST) {
            const scraperList = await this.scraperService.scrapeDay(channel, date);
            resultList.push(...await this.parseDay(scraperList));
        }
        return resultList;
    }
}

export default CryptoYodaScreenService;
