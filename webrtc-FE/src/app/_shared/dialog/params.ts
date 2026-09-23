
export interface ConfirmationDialogParams {
  title?: string;
  content?: string;
  okBtn?: string;
  cancelBtn?: string | boolean;
  okType?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'danger';
  showCloseBtn?: boolean;
}

export interface InfoDialogParams {
  title?: string;
  content?: string;
  okBtn?: string;
  cancelBtn?: string;
  okType?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'danger';
}
