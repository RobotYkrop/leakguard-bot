import {
  Breach,
  PasswordCheckResult,
  Analytics,
} from 'src/modules/breach-check/types/breach.types';

export interface IBreachChecker {
  checkEmailBreaches(email: string): Promise<Breach[]>;
  checkPassword(password: string): Promise<PasswordCheckResult>;
  getAnalytics?(email: string): Promise<Analytics>;
}
