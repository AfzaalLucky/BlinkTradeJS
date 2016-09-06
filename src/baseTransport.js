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

import Base from './base';
import MsgTypes from './constants/requests';
import * as RequestTypes from './constants/requestTypes';
import _ from 'lodash';
import {
  deleteRequest,
  generateRequestId,
} from './listener';

type StatusList = '1' | '2' | '4' | '8';

class BaseTransport extends Base {

  env: BlinkTradeEnv;

  send: Function;

  fetchTrade: Function;

  sendMessageAsPromise: Function;

  constructor(params?: BlinkTradeBase, env: BlinkTradeEnv) {
    super(params, env);

    this.send = env === 'ws' ? this.sendMessageAsPromise : this.fetchTrade;
  }

  balance(callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.BALANCE,
      BalanceReqID: generateRequestId(),
    };

    return new Promise((resolve, reject) => {
      return this.send(msg, callback).then(data => {
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
    });
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
      return this.send(msg, callback).then(data => {
        const { Columns, ...orders } = data;
        const OrdListGrp = _.map(data.OrdListGrp, order => _.zipObject(Columns, order));
        return resolve({
          ...orders,
          OrdListGrp,
        });
      }).catch(reject);
    });
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
      return this.send(msg, callback).then(data => {
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

    return this.send(msg, callback);
  }

  /**
   * statusList: 1-Pending, 2-In Progress, 4-Completed, 8-Cancelled
   */
  requestWithdrawList({
    page: Page = 0,
    pageSize: PageSize = 20,
    statusList: StatusList = ['1', '2', '4', '8'],
  }: {
    page?: number;
    pageSize?: number;
    statusList?: Array<StatusList>;
  } = {}, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.REQUEST_WITHDRAW_LIST,
      WithdrawListReqID: generateRequestId(),
      Page,
      PageSize,
      StatusList,
    };

    return new Promise((resolve, reject) => {
      return this.send(msg, callback).then(data => {
        const { Columns, ...withdrawData } = data;
        const WithdrawListGrp = _.map(data.WithdrawListGrp, withdraw => _.zipObject(Columns, withdraw));
        return resolve({
          ...withdrawData,
          WithdrawListGrp,
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
    const reqId = generateRequestId();
    const msg = {
      MsgType: MsgTypes.REQUEST_WITHDRAW,
      WithdrawReqID: reqId,
      ClOrdID: reqId,
      Method: method,
      Amount: amount,
      Currency: currency,
      Data: data,
    };

    return this.send(msg, callback);
  }

  requestDepositList({
    page: Page = 0,
    pageSize: PageSize = 20,
    status: StatusList = ['1', '2', '4', '8']
  }: {
    page: number;
    pageSize: number;
    status: Array<StatusList>;
  } = {}, callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.REQUEST_DEPOSIT_LIST,
      DepositListReqID: generateRequestId(),
      Page,
      PageSize,
      StatusList,
    };

    return new Promise((resolve, reject) => {
      return this.send(msg, callback).then(data => {
        const { Columns, ...depositData } = data;
        const DepositListGrp = _.map(data.DepositListGrp, deposit => _.zipObject(Columns, deposit));
        return resolve({
          ...depositData,
          DepositListGrp,
        });
      });
    });
  }

  requestDeposit({ currency = 'BTC', value, depositMethodId }: {
    value?: number;
    currency?: string;
    depositMethodId?: number;
  } = {}, callback?: Function): Promise<Object> {
    const reqId = generateRequestId();
    const msg: Object = {
      MsgType: MsgTypes.REQUEST_DEPOSIT,
      DepositReqID: reqId,
      ClOrdID: reqId,
      Currency: currency,
      BrokerID: this.brokerId,
    };

    if (currency !== 'BTC') {
      msg.DepositMethodID = depositMethodId;
      msg.Value = value;
    }

    return this.send(msg, callback);
  }

  requestDepositMethods(callback?: Function): Promise<Object> {
    const msg = {
      MsgType: MsgTypes.REQUEST_DEPOSIT_METHODS,
      DepositMethodReqID: generateRequestId(),
    };

    return this.send(msg, callback);
  }
}

export default BaseTransport;
