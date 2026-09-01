#include "ToolTimelineModel.h"

ToolTimelineModel::ToolTimelineModel(QObject *parent) : QAbstractListModel(parent) {}

int ToolTimelineModel::rowCount(const QModelIndex &parent) const { return parent.isValid() ? 0 : entries_.size(); }

QVariant ToolTimelineModel::data(const QModelIndex &index, int role) const {
  if (!index.isValid() || index.row() < 0 || index.row() >= entries_.size() || role != Qt::DisplayRole) return {};
  const ToolTimelineEntry &entry = entries_.at(index.row());
  QString text = QStringLiteral("%1 — %2").arg(entry.name, entry.status);
  if (entry.durationMs > 0) text += QStringLiteral(" (%1 ms)").arg(entry.durationMs);
  if (!entry.summary.isEmpty()) text += QStringLiteral(": %1").arg(entry.summary);
  return text;
}

void ToolTimelineModel::started(const QJsonObject &params) {
  const int row = entries_.size();
  beginInsertRows({}, row, row);
  entries_.append({params.value("callId").toString(), params.value("name").toString()});
  endInsertRows();
}

void ToolTimelineModel::finished(const QJsonObject &params) {
  const QString callId = params.value("callId").toString();
  for (int row = 0; row < entries_.size(); ++row) {
    ToolTimelineEntry &entry = entries_[row];
    if (entry.callId != callId) continue;
    entry.status = params.value("status").toString();
    entry.durationMs = params.value("durationMs").toInt();
    entry.summary = params.value("summary").toString();
    emit dataChanged(index(row), index(row));
    return;
  }
}

void ToolTimelineModel::markApproval(const QString &callId, const QString &status) {
  for (int row = 0; row < entries_.size(); ++row) {
    if (entries_[row].callId != callId) continue;
    entries_[row].status = status;
    emit dataChanged(index(row), index(row));
    return;
  }
}

void ToolTimelineModel::clear() {
  beginResetModel();
  entries_.clear();
  endResetModel();
}
