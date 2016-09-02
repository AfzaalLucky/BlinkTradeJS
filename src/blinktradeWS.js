/**
 * BlinkTradeJS SDK
 * (c) 2016-present BlinkTrade, Inc.
 *
 * This file is part of BlinkTradeJS
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @flow
 */

import MsgTypes from './constants/requests';
import * as RequestTypes from './constants/requestTypes';

import WebSocketTransport from './transports/WebSocketTransport';
import { EventEmitter } from 'events';
import {
  deleteRequest,
  registerListener,
  generateRequestId,
  registerEventEmitter,
} from './listener';

import {
  EVENTS,
  BALANCE,
} from './constants/actionTypes';

class BlinkTradeWS extends WebSocketTransport {

  /**
   * Session to store login information
   */
  session: Object;

  constructor(params: BlinkTradeBase) {
    super(params);

    this.session = {};
  }

  heartbeat(callback?: Function): Promise<Object> {
    const d = new Date();
    const msg: Object = {
      MsgType: MsgTypes.HEARTBEAT,
      TestReqID: d.getTime(),
      SendTime: d.getTime(),
    };

    return new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then((data) => {
        return resolve({
          ...data,
          Latency: new Date(Date.now()) - data.SendTime,
        });
      }).catch(reject);
    });
  }

  login({ username, password, secondFactor }: {
    username: string;
    password: string;
    secondFactor?: string;
  }, callback?: Function): Promise<Object> {
    let userAgent;
    if (!this.isNode) {
      userAgent = {
        UserAgent: window.navigator.userAgent,
        UserAgentLanguage: window.navigator.language,
        UserAgentPlatform: window.navigator.platform,
        UserAgentTimezoneOffset: new Date().getTimezoneOffset(),
      };
    }

    const msg: Object = {
      MsgType: MsgTypes.LOGIN,
      UserReqID: generateRequestId(),
      BrokerID: this.brokerId,
      Username: username,
      Password: password,
      UserReqTyp: '1',
      ...userAgent,
    };

    if (secondFactor) {
      msg.SecondFactor = secondFactor;
    }

    return new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        if (data.UserStatus === 1) {
          this.session = data;
          return resolve(data);
        }

        return reject(data);
      }).catch(reject);
    });
  }

  logout(callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.LOGOUT,
      BrokerID: this.brokerId,
      UserReqID: generateRequestId(),
      Username: this.session.Username,
      UserReqTyp: '2',
    };

    return super.sendMessageAsPromise(msg, callback);
  }

  profile(callback?: Function): Promise<Object> {
    const { VerificationData, ...profile } = this.session.Profile;
    return callback ? callback(profile) : Promise.resolve(profile);
  }

  balance(callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.BALANCE,
      BalanceReqID: generateRequestId(),
    };

    registerListener('U3', (balance) => {
      callback && callback(null, balance);
      return this.eventEmitter.emit(BALANCE, balance);
    });

    return super.emitterPromise(new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        const Available = {};
        const balances = data[this.brokerId];
        Object.keys(balances).map(currency => {
          if (!currency.includes('locked')) {
            Available[currency] = balances[currency] - balances[`${currency}_locked`];
          }
          return Available;
        });

        return resolve({ ...data, Available });
      }).catch(reject);
    }));
  }

  subscribeTicker(symbols: Array<string>, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.SECURITY_STATUS,
      SecurityStatusReqID: generateRequestId(),
      SubscriptionRequestType: '1',
      Instruments: symbols,
    };

    const formatTicker = (data) => {
      return {
        ...data,
        SellVolume: data.SellVolume / 1e8,
        LowPx: data.LowPx / 1e8,
        LastPx: data.LastPx / 1e8,
        BestAsk: data.BestAsk / 1e8,
        HighPx: data.HighPx / 1e8,
        BuyVolume: data.BuyVolume / 1e8,
        BestBid: data.BestBid / 1e8,
      };
    };

    return super.emitterPromise(new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        resolve(formatTicker(data));
        registerEventEmitter({ SecurityStatusReqID: data.SecurityStatusReqID }, (ticker) => {
          callback && callback(null, formatTicker(ticker));
          return this.eventEmitter.emit(`BLINK:${data.Symbol}`, formatTicker(ticker));
        });
      }).catch(reject);
    }));
  }

  unSubscribeTicker(SecurityStatusReqID: number): number {
    const msg = {
      MsgType: MsgTypes.SECURITY_STATUS,
      SecurityStatusReqID,
      SubscriptionRequestType: '2',
    };

    super.sendMessage(msg);
    return SecurityStatusReqID;
  }

  subscribeOrderbook(symbols: Array<string>, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.MARKET_DATA_FULL_REFRESH,
      MDReqID: generateRequestId(),
      SubscriptionRequestType: '1',
      MarketDepth: 0,
      MDUpdateType: '1', // Incremental refresh
      MDEntryTypes: ['0', '1', '2'],
      Instruments: symbols,
    };

    const subscribeEvent = (data) => {
      if (data.MDBkTyp === '3') {
        data.MDIncGrp.map(order => {
          const dataOrder = {
            index: order.MDEntryPositionNo,
            price: order.MDEntryPx / 1e8,
            size: order.MDEntrySize / 1e8,
            side: order.MDEntryType === '0' ? 'buy' : 'sell',
            userId: order.UserID,
            orderId: order.OrderID,
            symbol: order.Symbol,
            time: new Date(`${order.MDEntryDate} ${order.MDEntryTime}`).toString(),
          };

          callback && callback(null, dataOrder);

          switch (order.MDEntryType) {
            case '0':
            case '1':
              const orderbookEvent = EVENTS.ORDERBOOK[order.MDUpdateAction];
              return this.eventEmitter.emit(orderbookEvent, { ...dataOrder, type: orderbookEvent });
            case '2':
              const tradeEvent = EVENTS.TRADES[order.MDUpdateAction];
              return this.eventEmitter.emit(tradeEvent, { ...dataOrder, type: tradeEvent });
            case '4':
              break;
            default:
              return null;
          }
          return null;
        });
      }
    };

    return super.emitterPromise(new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        if (data.MsgType === 'W') {
          // Split orders in bids and asks
          /* eslint-disable no-param-reassign */
          const { bids, asks } = data.MDFullGrp
          .filter(order => order.MDEntryType === '0' || order.MDEntryType === '1')
          .reduce((prev, order) => {
            const side = order.MDEntryType === '0' ? 'bids' : 'asks';
            (prev[side] || (prev[side] = [])).push([
              order.MDEntryPx / 1e8,
              order.MDEntrySize / 1e8,
              order.UserID,
            ]);
            return prev;
          }, []);
          /* eslint-enable no-param-reassign */

          registerEventEmitter({ MDReqID: data.MDReqID }, subscribeEvent);

          return resolve({
            ...data,
            MDFullGrp: {
              [data.Symbol]: {
                bids,
                asks,
              },
            },
          });
        }
      }).catch(err => reject(err));
    }));
  }

  unSubscribeOrderbook(MDReqID: number): number {
    const msg = {
      MsgType: MsgTypes.MARKET_DATA_UNSUBSCRIBE,
      MDReqID,
      MarketDepth: 0,
      SubscriptionRequestType: '2',
    };

    super.sendMessage(msg);
    return MDReqID;
  }

  sendOrder({ side, amount, price, symbol }: {
    side: '1' | '2';
    price: number;
    amount: number;
    symbol: string;
  }, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.ORDER_SEND,
      ClOrdID: generateRequestId(),
      Symbol: symbol,
      Side: side,
      OrdType: '2',
      Price: price,
      OrderQty: amount,
      BrokerID: this.brokerId,
    };

    return new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        deleteRequest(RequestTypes.CLIENT_ORDER_ID);
        resolve(data);
      }).catch(reject);
    });
  }

  cancelOrder(param: number | {
    orderId: number;
    clientId?: number;
  }, callback?: Function): Promise<Object> {
    const orderId = param.orderId ? param.orderId : param;
    const msg: Object = {
      MsgType: MsgTypes.ORDER_CANCEL,
      OrderID: orderId,
    };

    if (param.clientId) {
      msg.ClOrdID = param.clientId;
    }

    return super.sendMessageAsPromise(msg, callback);
  }

  myOrders({ page: Page = 0, pageSize: PageSize = 40 }: {
    page?: number;
    pageSize?: number;
  } = {}, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.ORDER_LIST,
      OrdersReqID: generateRequestId(),
      Page,
      PageSize,
    };

    return new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        const { Columns, ...orders } = data;
        const OrdListGrp = [];
        data.OrdListGrp.map(order => {
          return OrdListGrp.push({
            ClOrdID: order[0],
            OrderID: order[1],
            CumQty: order[2],
            OrdStatus: order[3],
            LeavesQty: order[4],
            CxlQty: order[5],
            AvgPx: order[6],
            Symbol: order[7],
            Side: order[8],
            OrdType: order[9],
            OrderQty: order[10],
            Price: order[11],
            OrderDate: order[12],
            Volume: order[13],
            TimeInForce: order[14],
          });
        });
        return resolve({
          ...orders,
          OrdListGrp,
        });
      }).catch(reject);
    });
  }

  executionReport(callback?: Function): EventEmitter {
    registerListener('8', (data) => {
      callback && callback(data);
      return this.eventEmitter.emit(EVENTS.EXECUTION_REPORT[data.ExecType], data);
    });

    return this.eventEmitter;
  }

  tradeHistory({ page: Page = 0, pageSize: PageSize = 80}: {
    page?: number;
    pageSize?: number;
  } = {}, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.TRADE_HISTORY,
      TradeHistoryReqID: generateRequestId(),
      Page,
      PageSize,
    };

    return new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        let last = 0;
        let IsPump = false;
        const { Columns, ...trades } = data;
        const TradeHistory = {};

        data.TradeHistoryGrp.reverse().map(trade => {
          IsPump = last === trade[3] ? IsPump : last <= trade[3];

          last = trade[3];
          TradeHistory[trade[1]] = TradeHistory[trade[1]] || [];
          return TradeHistory[trade[1]].unshift({
            TradeID: trade[0],
            Market: trade[1],
            Side: trade[2],
            Price: trade[3],
            Size: trade[4],
            Buyer: trade[5],
            Seller: trade[6],
            Created: trade[7],
            IsPump,
          });
        });

        return resolve({
          ...trades,
          TradeHistoryGrp: TradeHistory,
        });
      }).catch(reject);
    });
  }

  /**
   * statusList: 1-Pending, 2-In Progress, 4-Completed, 8-Cancelled
   */
  listWithdraws({
    page: Page = 0,
    pageSize: PageSize = 20,
    statusList: StatusList = ['1', '2', '4', '8'],
  }: {
    page?: number;
    pageSize?: number;
    statusList?: Array<string>;
  } = {}, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.REQUEST_WITHDRAW_LIST,
      WithdrawListReqID: generateRequestId(),
      Page,
      PageSize,
      StatusList,
    };

    return new Promise((resolve, reject) => {
      return super.sendMessageAsPromise(msg, callback).then(data => {
        const { Columns, ...withdrawData } = data;
        const WithdrawList = [];
        data.WithdrawListGrp.map(withdraw => {
          return WithdrawList.push({
            WithdrawID: withdraw[0],
            Method: withdraw[1],
            Currency: withdraw[2],
            Amount: withdraw[3],
            Data: withdraw[4],
            Created: withdraw[5],
            Status: withdraw[6],
            ReasonID: withdraw[7],
            Reason: withdraw[8],
            PercentFee: withdraw[9],
            FixedFee: withdraw[10],
            PaidAmount: withdraw[11],
            UserID: withdraw[12],
            Username: withdraw[13],
            BrokerID: withdraw[14],
            ClOrdID: withdraw[15],
          });
        });

        return resolve({
          ...withdrawData,
          WithdrawListGrp: WithdrawList,
        });
      }).catch(reject);
    });
  }

  requestWithdraw({ amount, data, currency = 'BTC', method = 'bitcoin' }: {
    data: Object,
    amount: number;
    method?: string;
    currency?: string;
  }, callback: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.REQUEST_WITHDRAW,
      WithdrawReqID: generateRequestId(),
      Method: method,
      Amount: amount,
      Currency: currency,
      Data: data,
    };

    return super.sendMessageAsPromise(msg, callback);
  }

  requestDeposit({ currency, value, depositMethodId }: {
    value?: number;
    currency: string;
    depositMethodId?: number;
  }, callback?: Function): Promise<Object> {
    const msg: Object = {
      MsgType: MsgTypes.REQUEST_DEPOSIT,
      DepositReqID: generateRequestId(),
      Currency: currency,
      BrokerID: this.brokerId,
    };

    if (currency !== 'BTC') {
      msg.DepositMethodID = depositMethodId;
      msg.Value = value;
    }

    return super.sendMessageAsPromise(msg, callback);
  }
}

export default BlinkTradeWS;
